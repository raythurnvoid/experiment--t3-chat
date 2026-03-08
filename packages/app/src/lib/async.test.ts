import { describe, expect, test, vi } from "vitest";
import { CoalescedRunner } from "./async.ts";

describe("CoalescedRunner", () => {
	test("Should run the task immediately when idle", async () => {
		const runner = new CoalescedRunner();
		const task = vi.fn(async () => "value");

		await expect(runner.run(task)).resolves.toEqual({ aborted: false, value: "value" });
		expect(task).toHaveBeenCalledTimes(1);
	});

	test("Should allow running a task immediately after flush when idle", async () => {
		const runner = new CoalescedRunner();
		const task = vi.fn(async () => "value");

		await expect(runner.flush()).resolves.toEqual({ aborted: false, value: undefined });
		await expect(runner.run(task)).resolves.toEqual({ aborted: false, value: "value" });
		expect(task).toHaveBeenCalledTimes(1);
	});

	test("Should resolve flush without task immediately when idle", async () => {
		const runner = new CoalescedRunner();

		await expect(runner.flush()).resolves.toEqual({ aborted: false, value: undefined });
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

	test("Should allow running a task after flush once in-flight work completes", async () => {
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
		const flushPromise = runner.flush();
		const competingRunPromise = runner.run(competingTask);

		await expect(competingRunPromise).resolves.toEqual({ aborted: true });
		expect(competingTask).not.toHaveBeenCalled();

		firstDeferred.resolve("first");

		await expect(firstRunPromise).resolves.toEqual({ aborted: false, value: "first" });
		await expect(flushPromise).resolves.toEqual({ aborted: false, value: undefined });
		await expect(runner.run(flushedTask)).resolves.toEqual({ aborted: false, value: "flush" });
		expect(flushedTask).toHaveBeenCalledTimes(1);
		expect(runOrder).toEqual(["first", "flush"]);
	});

	test("Should wait for in-flight work when flushing without task", async () => {
		const runner = new CoalescedRunner();
		const runOrder: string[] = [];
		const firstDeferred = Promise.withResolvers<string>();

		const firstRunPromise = runner.run(async () => {
			runOrder.push("first");
			return firstDeferred.promise;
		});
		const flushPromise = runner.flush();

		await Promise.resolve();
		expect(runOrder).toEqual(["first"]);

		firstDeferred.resolve("first");

		await expect(firstRunPromise).resolves.toEqual({ aborted: false, value: "first" });
		await expect(flushPromise).resolves.toEqual({ aborted: false, value: undefined });
	});

	test("Should allow the flush caller to run a task after queued microtasks drain", async () => {
		const runner = new CoalescedRunner();
		const runOrder: string[] = [];
		const firstDeferred = Promise.withResolvers<string>();

		runner.run(async () => {
			runOrder.push("first");
			return firstDeferred.promise.then((value) => {
				runOrder.push("first:then");
				queueMicrotask(() => {
					runOrder.push("middle");
					runner.run(async () => {
						runOrder.push("middle-task");
						return "middle-task";
					});
				});
				return value;
			});
		});

		const targetRunPromise = Promise.try(async () => {
			await runner.flush();
			runOrder.push("after-flush");
			return runner.run(async () => {
				runOrder.push("target");
				return "target";
			});
		});

		firstDeferred.resolve("first");

		await expect(targetRunPromise).resolves.toEqual({ aborted: false, value: "target" });
		expect(runOrder).toEqual(["first", "first:then", "middle", "middle-task", "after-flush", "target"]);
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

	test("Should return aborted from taskless flush after dispose", async () => {
		const runner = new CoalescedRunner();
		const firstDeferred = Promise.withResolvers<string>();

		runner.run(async () => firstDeferred.promise);
		const flushPromise = runner.flush();

		runner.dispose();

		await expect(flushPromise).resolves.toEqual({ aborted: true });

		firstDeferred.resolve("first");
	});
});
