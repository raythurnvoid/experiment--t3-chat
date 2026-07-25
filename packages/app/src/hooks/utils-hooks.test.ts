import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useFn } from "@/hooks/utils-hooks.ts";

afterEach(() => {
	cleanup();
});

describe("useFn", () => {
	test("returns the same function identity across re-renders", () => {
		const { result, rerender } = renderHook(({ handler }) => useFn(handler), {
			initialProps: { handler: (() => "first") as () => string },
		});

		const firstFn = result.current;

		rerender({ handler: () => "second" });

		expect(result.current).toBe(firstFn);
	});

	test("calls the latest handler after a re-render", () => {
		const firstHandler = vi.fn();
		const secondHandler = vi.fn();

		const { result, rerender } = renderHook(({ handler }) => useFn(handler), {
			initialProps: { handler: firstHandler as () => void },
		});

		rerender({ handler: secondHandler });

		result.current();

		expect(firstHandler).not.toHaveBeenCalled();
		expect(secondHandler).toHaveBeenCalledTimes(1);
	});

	test("forwards arguments and returns the handler result", () => {
		const { result } = renderHook(() => useFn((a: number, b: number) => a + b));

		expect(result.current(2, 3)).toBe(5);
	});

	test("reads the latest state while keeping the same function identity", () => {
		const { result } = renderHook(() => {
			const [count, setCount] = useState(0);
			const getCount = useFn(() => count);
			return { getCount, setCount };
		});

		const stableGetCount = result.current.getCount;

		expect(stableGetCount()).toBe(0);

		act(() => {
			result.current.setCount(5);
		});

		expect(result.current.getCount).toBe(stableGetCount);
		expect(stableGetCount()).toBe(5);
	});

	test("does nothing when the handler is null or undefined", () => {
		const { result, rerender } = renderHook(({ handler }) => useFn(handler), {
			initialProps: { handler: null as null | (() => string) },
		});

		expect(result.current()).toBeUndefined();

		rerender({ handler: () => "ready" });

		expect(result.current()).toBe("ready");
	});
});
