import { describe, expect, test } from "vitest";
import { async_all_settled_with_limit } from "./async-utils.ts";

describe("async_all_settled_with_limit", () => {
	test("Should return all results in input order", async () => {
		const results = await async_all_settled_with_limit({
			items: [1, 2, 3, 4],
			limit: 2,
			run: async (item) => item * 10,
		});

		expect(results).toEqual([
			{ status: "fulfilled", value: 10 },
			{ status: "fulfilled", value: 20 },
			{ status: "fulfilled", value: 30 },
			{ status: "fulfilled", value: 40 },
		]);
	});

	test("Should never run more items than the limit at the same time", async () => {
		let active = 0;
		let maxActive = 0;

		await async_all_settled_with_limit({
			items: [1, 2, 3, 4, 5, 6, 7, 8],
			limit: 3,
			run: async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
			},
		});

		expect(maxActive).toBe(3);
	});

	test("Should start items in FIFO order as slots free up", async () => {
		const started: number[] = [];
		const resolvers: Array<() => void> = [];

		const all = async_all_settled_with_limit({
			items: [0, 1, 2, 3],
			limit: 2,
			run: (item) => {
				started.push(item);
				return new Promise<void>((resolve) => {
					resolvers.push(resolve);
				});
			},
		});

		// Only the first `limit` items start right away.
		expect(started).toEqual([0, 1]);

		resolvers[0]?.();
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2]);

		resolvers[1]?.();
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2, 3]);

		resolvers[2]?.();
		resolvers[3]?.();
		await all;
	});

	test("Should capture a rejection without stopping the other items", async () => {
		const error = new Error("boom");
		const results = await async_all_settled_with_limit({
			items: [1, 2, 3],
			limit: 1,
			run: async (item) => {
				if (item === 2) throw error;
				return item;
			},
		});

		expect(results).toEqual([
			{ status: "fulfilled", value: 1 },
			{ status: "rejected", reason: error },
			{ status: "fulfilled", value: 3 },
		]);
	});

	test("Should return an empty array for no items", async () => {
		const results = await async_all_settled_with_limit({
			items: [],
			limit: 5,
			run: async () => {
				throw new Error("should not run");
			},
		});

		expect(results).toEqual([]);
	});

	test("Should treat a limit below 1 as 1", async () => {
		let active = 0;
		let maxActive = 0;

		const results = await async_all_settled_with_limit({
			items: [1, 2],
			limit: 0,
			run: async (item) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active -= 1;
				return item;
			},
		});

		expect(maxActive).toBe(1);
		expect(results).toEqual([
			{ status: "fulfilled", value: 1 },
			{ status: "fulfilled", value: 2 },
		]);
	});
});
