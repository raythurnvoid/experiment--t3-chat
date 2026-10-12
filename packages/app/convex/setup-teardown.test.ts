import type { convexTest } from "convex-test";

type test_convex_Instance = ReturnType<typeof convexTest>;

// `test_convex` (setup-base.test.ts) adds each instance here, with the names of the components it
// registers, and setup-env.test.ts runs `test_convex_teardown` after each test. The hook lives in that
// setup file because Vitest runs setup files again for every test file, also when test files share
// loaded modules (`isolate: false`). A hook in setup-base.test.ts would be added only in the first
// test file that loads it. This file loads no app modules, so the setup file can import it before a
// test file's `vi.mock` calls.
export const test_convex_instances: Array<{ t: test_convex_Instance; components: string[] }> = [];

async function test_convex_cancel_pending_jobs(ctx: Parameters<Parameters<test_convex_Instance["run"]>[0]>[0]) {
	const jobs = await ctx.db.system.query("_scheduled_functions").collect();
	for (const job of jobs) {
		if (job.state.kind === "pending") {
			await ctx.scheduler.cancel(job._id);
		}
	}
}

// convex-test runs scheduled functions as floating promises — nothing awaits them, and teardown does
// not either. A README seed seeded by one test was still issuing its R2 writes while a later test
// ran, so those writes landed in that test's `globalThis.fetch` spy and failed an exact-compare
// assertion at random. Cancel what has not started yet, then wait for whatever already has, so every
// test owns its own background work instead of leaving it for the next one.
export async function test_convex_teardown() {
	const instances = test_convex_instances.splice(0);
	if (instances.length === 0) {
		return;
	}

	// Vitest registers this hook from a setup file, and its default `stack` order runs such hooks
	// *after* each test file's own `afterEach` — including the ones that put the real `fetch` back. So
	// a request sent from here would really leave the machine. We block it: these leftover jobs are
	// checked by no test, and they fail with or without network, only slower.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (() => Promise.reject(new Error("fetch is closed during test teardown"))) as typeof fetch;

	try {
		for (const { t, components } of instances) {
			try {
				await t.run(test_convex_cancel_pending_jobs);
				// Components keep their own scheduled jobs (for example workpool batches). Their timers
				// would run them in a later test, or in a later test file when files share a worker.
				// `runInComponent` exists on convex-test instances but is not in its types.
				const { runInComponent } = t as unknown as {
					runInComponent: (componentPath: string, handler: typeof test_convex_cancel_pending_jobs) => Promise<void>;
				};
				for (const component of components) {
					await runInComponent(component, test_convex_cancel_pending_jobs);
				}
				await t.finishInProgressScheduledFunctions();
			} catch {
				// Best-effort cleanup. A test that already deleted its own data can make this throw,
				// and a cleanup failure must not turn into a test failure.
			}
		}
	} finally {
		globalThis.fetch = realFetch;
	}
}
