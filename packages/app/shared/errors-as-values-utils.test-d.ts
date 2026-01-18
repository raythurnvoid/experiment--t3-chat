import { expectTypeOf, test } from "vitest";
import { AbortReason, Result } from "./errors-as-values-utils.ts";

// TypeScript native type utils tests
test("Be able to extract _nay from Result", () => {
	type TestType = Result<{ _nay: { message: "error" } }> | string | number;
	type ExtractedType = Extract<TestType, Result<{ _nay: any }>>;

	expectTypeOf<ExtractedType>().toEqualTypeOf<Result<{ _nay: { message: "error" } }>>();
});

test("Be able to exclude _nay from Result", () => {
	type TestType = Result<{ _nay: { message: "error" } }> | string | number;
	type ExcludedType = Exclude<TestType, Result<{ _nay: any }>>;

	expectTypeOf<ExcludedType>().toEqualTypeOf<string | number>();
});

// AbortReason tests
test("AbortReason has correct type structure", () => {
	const reason = new AbortReason("user cancelled");

	expectTypeOf(reason).toHaveProperty("name");
	expectTypeOf(reason.name).toBeString();
	expectTypeOf(reason.message).toBeString();
});

// Result class tests
test("Result with _yay value has correct type structure", () => {
	type OkResult = Result<{ _yay: string }> | Result<{ _nay: { message: string } }>;
	const result = {} as OkResult & { _yay: string };

	// Verify that result.ok is accessible and has the correct type
	expectTypeOf(result._yay).toBeString();
});

test("Result with _nay value has correct type structure", () => {
	type NayResultType = Result<{ _yay: string }> | Result<{ _nay: { message: string } }>;
	const result = {} as NayResultType;

	// Verify that result._nay is accessible and has the correct type
	if (result._nay) {
		expectTypeOf(result._nay.message).toBeString();
	}
});

test("Can infer data by discriminating on message", () => {
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
			expectTypeOf(result._nay.data).toEqualTypeOf<{ foo: "bar" }>();
		} else {
			expectTypeOf(result._nay.data).toBeNever();
		}

		return;
	}

	expectTypeOf(result._yay).toBeString();
});
