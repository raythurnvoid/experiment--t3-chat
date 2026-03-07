import { describe, expect, test, vi } from "vitest";
import { CoalescedRunner } from "./async.ts";

describe("CoalescedRunner", () => {
	test("Should run the task immediately when idle", async () => {
		const runner = new CoalescedRunner();
		const task = vi.fn(async () => "value");

		await expect(runner.run(task)).resolves.toEqual({ aborted: false, value: "value" });
		expect(task).toHaveBeenCalledTimes(1);
	});

	test("Should flush the task immediately when idle", async () => {
		const runner = new CoalescedRunner();
		const task = vi.fn(async () => "value");

		await expect(runner.flush(task)).resolves.toEqual({ aborted: false, value: "value" });
		expect(task).toHaveBeenCalledTimes(1);
	});

	test("Should keep only the latest pending task while a task is in flight", async () => {
		const runner = new CoalescedRunner();
		const runOrder: string[] = [];
		const firstDeferred = Promise.withResolvers<string>();
		const secondTask = vi.fn(async () => {
			runOrder.push("second");
			return "second";
		});
		const thirdTask = vi.fn(async () => {
			runOrder.push("third");
			return "third";
		});

		const firstRunPromise = runner.run(async () => {
			runOrder.push("first");
			return firstDeferred.promise;
		});
		const secondRunPromise = runner.run(secondTask);
		const thirdRunPromise = runner.run(thirdTask);

		await expect(secondRunPromise).resolves.toEqual({ aborted: true });
		expect(secondTask).not.toHaveBeenCalled();
		expect(runOrder).toEqual(["first"]);

		firstDeferred.resolve("first");

		await expect(firstRunPromise).resolves.toEqual({ aborted: false, value: "first" });
		await expect(thirdRunPromise).resolves.toEqual({ aborted: false, value: "third" });
		expect(thirdTask).toHaveBeenCalledTimes(1);
		expect(runOrder).toEqual(["first", "third"]);
	});

	test("Should continue draining after the current task rejects", async () => {
		const runner = new CoalescedRunner();
		const runOrder: string[] = [];
		const error = new Error("boom");

		const firstRunPromise = runner.run(async () => {
			runOrder.push("first");
			throw error;
		});
		const secondRunPromise = runner.run(async () => {
			runOrder.push("second");
			return "second";
		});

		await expect(firstRunPromise).rejects.toBe(error);
		await expect(secondRunPromise).resolves.toEqual({ aborted: false, value: "second" });
		expect(runOrder).toEqual(["first", "second"]);
	});

	test("Should keep re-queueing the flushed task until it executes", async () => {
		const runner = new CoalescedRunner();
		const runOrder: string[] = [];
		const firstDeferred = Promise.withResolvers<string>();
		const competingTask = vi.fn(async () => {
			runOrder.push("competing");
			return "competing";
		});
		const flushedTask = vi.fn(async () => {
			runOrder.push("flush");
			return "flush";
		});

		const firstRunPromise = runner.run(async () => {
			runOrder.push("first");
			return firstDeferred.promise;
		});
		const flushPromise = runner.flush(flushedTask);
		const competingRunPromise = runner.run(competingTask);

		await expect(competingRunPromise).resolves.toEqual({ aborted: true });
		expect(competingTask).not.toHaveBeenCalled();

		firstDeferred.resolve("first");

		await expect(firstRunPromise).resolves.toEqual({ aborted: false, value: "first" });
		await expect(flushPromise).resolves.toEqual({ aborted: false, value: "flush" });
		expect(flushedTask).toHaveBeenCalledTimes(1);
		expect(runOrder).toEqual(["first", "flush"]);
	});

	test("Should abort the pending task on dispose without aborting the current task", async () => {
		const runner = new CoalescedRunner();
		const firstDeferred = Promise.withResolvers<string>();
		const pendingTask = vi.fn(async () => "pending");
		const laterTask = vi.fn(async () => "later");

		const firstRunPromise = runner.run(async () => firstDeferred.promise);
		const pendingRunPromise = runner.run(pendingTask);

		runner.dispose();

		await expect(pendingRunPromise).resolves.toEqual({ aborted: true });

		firstDeferred.resolve("first");

		await expect(firstRunPromise).resolves.toEqual({ aborted: false, value: "first" });
		await expect(runner.run(laterTask)).resolves.toEqual({ aborted: true });
		expect(pendingTask).not.toHaveBeenCalled();
		expect(laterTask).not.toHaveBeenCalled();
	});

	test("Should return aborted from flush after dispose", async () => {
		const runner = new CoalescedRunner();
		const firstDeferred = Promise.withResolvers<string>();
		const flushedTask = vi.fn(async () => "flush");

		const firstRunPromise = runner.run(async () => firstDeferred.promise);
		const flushPromise = runner.flush(flushedTask);

		runner.dispose();

		await expect(flushPromise).resolves.toEqual({ aborted: true });

		firstDeferred.resolve("first");

		await expect(firstRunPromise).resolves.toEqual({ aborted: false, value: "first" });
		expect(flushedTask).not.toHaveBeenCalled();
	});
});
