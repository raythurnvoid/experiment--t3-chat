import "./setup-env.test.ts";
import { convexTest, type TestConvexRoot } from "convex-test";
import schema from "./schema.ts";
import type { DataModel } from "./_generated/dataModel";
import polar_test from "@convex-dev/polar/test";
import presence_test from "@convex-dev/presence/test";
import workpool_test from "@convex-dev/workpool/test";
import rate_limiter_test from "@convex-dev/rate-limiter/test";
import r2_test from "@convex-dev/r2/test";
import { test_convex_instances } from "./setup-teardown.test.ts";

// The part of setup.test.ts that does not load the app modules. setup.test.ts imports almost every
// convex module (and tiptap), which costs a test file many seconds of import. A test file that only
// needs `test_convex` imports this file; setup.test.ts re-exports it for every other file.
//
// `import.meta.glob` lives here too: Vitest's fs module cache skips a file that uses it, so keeping it
// out of setup.test.ts lets that big file be cached.

// #region helpers

const convex_test_modules = import.meta.glob("./**/*.ts");

const test_convex_memo_schemas = new WeakSet<object>();

// convex-test calls `export()` on every table of a schema for each new instance and for each
// registered component. That builds the same validator JSON again each time, about 3 ms per test.
// Build it once per table. convex-test only reads the result.
function test_convex_memo_schema_exports<S extends { tables: Record<string, unknown> }>(schema: S) {
	if (test_convex_memo_schemas.has(schema)) return schema;
	test_convex_memo_schemas.add(schema);
	for (const table of Object.values(schema.tables) as Array<{ export: () => unknown }>) {
		const exported = table.export();
		table.export = () => exported;
	}
	return schema;
}

// Keep the named return type; inferring it makes the full type check slower.
export function test_convex(
	options: {
		transactionLimits?: Parameters<typeof convexTest>[0]["transactionLimits"];
	} = {},
): TestConvexRoot<DataModel> {
	const t = convexTest({
		schema: test_convex_memo_schema_exports(schema),
		modules: convex_test_modules,
		transactionLimits: options.transactionLimits,
	});
	test_convex_instances.push(t);
	const registerComponent = t.registerComponent.bind(t);
	t.registerComponent = (name, componentSchema, modules) =>
		registerComponent(name, test_convex_memo_schema_exports(componentSchema), modules);
	const withIdentity = t.withIdentity.bind(t);
	t.withIdentity = ((identity) => {
		// Use realistic Clerk identities by default; tests that cover the missing
		// email invariant opt out explicitly with `email: undefined`.
		if (identity.issuer === "https://clerk.test" && !("email" in identity)) {
			return withIdentity({
				...identity,
				email: "test-user@example.com",
			});
		}

		return withIdentity(identity);
	}) as typeof t.withIdentity;
	t.registerComponent(
		"polar",
		polar_test.schema as unknown as Parameters<typeof t.registerComponent>[1],
		polar_test.modules as unknown as Parameters<typeof t.registerComponent>[2],
	);
	presence_test.register(t as unknown as Parameters<typeof presence_test.register>[0]);
	workpool_test.register(t, "billing_workpool_bootstrap");
	workpool_test.register(t, "billing_workpool_cancellation");
	workpool_test.register(t, "billing_workpool_usage_event");
	workpool_test.register(t, "files_content_materialization_workpool");
	workpool_test.register(t, "files_upload_conversion_workpool");
	workpool_test.register(t, "files_transfer_workpool");
	workpool_test.register(t, "data_deletion_workpool");
	workpool_test.register(t, "github_mounts_workpool");
	workpool_test.register(t, "plugins_runtime_workpool");
	workpool_test.register(t, "plugins_scheduled_runs_workpool");
	workpool_test.register(t, "ai_chat_bash_jobs_workpool");
	rate_limiter_test.register(t, "rate_limiter");
	r2_test.register(t as unknown as Parameters<typeof r2_test.register>[0]);
	return t;
}

// #endregion
