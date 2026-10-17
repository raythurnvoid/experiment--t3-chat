import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { Workpool } from "@convex-dev/workpool";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { migrate_metadata_doc_area } from "./migrations.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_finish_saved_scope_jobs,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { budget_recorder, insert_saved_node, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import { files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("metadata-doc-area-test-work" as never);
	// The Move fixture saves a file and starts a real Move.
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asOwner };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function committed_docs(f: Pick<Fixture, "t">) {
	return f.t.run(async (ctx) =>
		(await ctx.db.query("files_metadata_docs").collect()).flatMap((doc) =>
			doc.sourceKind === "committed" ? [doc] : [],
		),
	);
}

/** Remove the area like docs written before it existed. The overlay hook removes their area rows too. */
async function strip_area(f: Fixture) {
	await test_run_with_flush(f.t, async (ctx) => {
		for (const doc of await ctx.db.query("files_metadata_docs").collect())
			if (doc.sourceKind === "committed")
				await ctx.db.patch("files_metadata_docs", doc._id, { restrictedScopeNodeId: undefined });
	});
}

async function audit(f: Pick<Fixture, "t">) {
	const problems = [];
	let cursor: string | null = null;
	do {
		const page: Awaited<ReturnType<typeof f.t.query<typeof internal.migrations.audit_metadata_doc_area>>> =
			await f.t.query(internal.migrations.audit_metadata_doc_area, { cursor });
		problems.push(...page.page);
		cursor = page.isDone ? null : page.continueCursor;
	} while (cursor);
	return problems;
}

async function area_rows(f: Fixture) {
	await test_compact_metadata_catalog(f.t);
	return (await f.t.run((ctx) => ctx.db.query("files_metadata_catalog").collect()))
		.filter((row) => row.family.startsWith("area_"))
		.map((row) => `${row.family}:${row.parentId}:${row.fieldPath}:${row.stringValue ?? ""}=${row.count}`)
		.sort();
}

test("the backfill gives every committed doc its node's area and brings back the area rows", async () => {
	const f = await fixture();
	const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
	const folder = async (path: string) => {
		const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path });
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const open = await folder("/open");
	const hr = await folder("/hr");
	const review = await folder("/hr/review");
	for (const nodeId of [open, review]) {
		await f.t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: f.db.userId });
		expect(
			await f.asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: f.db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: "level: secret\n",
			}),
		).toEqual({ _yay: null });
	}
	expect(
		(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: hr }))._nay,
	).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	await test_finish_saved_scope_jobs(f.t);
	const expectedRows = await area_rows(f);
	expect(expectedRows).toEqual([
		`area_key:${hr}:metadata.level:=1`,
		"area_key:root:metadata.level:=1",
		`area_value:${hr}:metadata.level:secret=1`,
		"area_value:root:metadata.level:secret=1",
	]);

	await strip_area(f);
	expect(await area_rows(f), "a doc without its area counts in no area row").toEqual([]);
	expect((await audit(f)).map((problem) => problem.problem)).toEqual(Array(4).fill("missing_field"));
	expect(
		await f.t.query(internal.migrations.audit_metadata_doc_area_precheck, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		}),
	).toEqual({ liveMoveCohortId: null, subtreeOpIds: [] });

	const status = await f.t.action((ctx) =>
		runToCompletion(ctx, components.migrations, internal.migrations.migrate_metadata_doc_area),
	);
	expect(status.state).toBe("success");

	const byNode = new Map((await committed_docs(f)).map((doc) => [doc.fileNodeId, doc.restrictedScopeNodeId]));
	expect(byNode).toEqual(
		new Map<Id<"files_nodes">, Id<"files_nodes"> | null>([
			[open, null],
			[review, hr],
		]),
	);
	expect(await audit(f)).toEqual([]);
	expect(await area_rows(f)).toEqual(expectedRows);
});

test("the backfill skips a doc whose folder a Move reserves before the Move tags the node", async () => {
	const f = await test_create_saved_placement_fixture();
	f.t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	// The Move reserves the folder's subtree. Its child has no `moveCohortId` yet.
	const childId = await f.t.run(async (ctx) => {
		await ctx.db.insert("files_move_source_reservations", {
			cohortId: f.cohortId,
			source: { kind: "saved", id: f.parentId },
			mode: "subtree",
			userId: null,
			generation: 1,
		});
		const folder = (await ctx.db.get("files_nodes", f.parentId))!;
		const child = await insert_saved_node(ctx, f.db, { parent: folder, name: "child.md", kind: "file" });
		await ctx.db.insert("files_metadata_docs", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			sourceKind: "committed",
			fileNodeId: child._id,
			path: child.path,
			treePath: child.treePath,
			fieldPath: "metadata.level",
			docKind: "value",
			valueKind: "string",
			stringValue: "secret",
		});
		return child._id;
	});

	const status = await f.t.action((ctx) =>
		runToCompletion(ctx, components.migrations, internal.migrations.migrate_metadata_doc_area),
	);
	expect(status.state, "the batch does not throw on the Move guard").toBe("success");
	expect(
		(await audit(f)).filter((problem) => problem.fileNodeId === childId).map((problem) => problem.problem),
		"the doc waits for a run after the Move",
	).toEqual(["missing_field"]);
});

test("one batch of the largest docs stays far below the limits", async () => {
	const f = await fixture();
	// The largest docs a write can make: a 1,024-character path, 160-character keys, and string values
	// cut to 1,025 characters. Half the values have 3 UTF-8 bytes per character (the largest docs), half
	// are 1,024 ASCII bytes (the largest that still get an area value row). 896 docs is the most one
	// file can have.
	const path = `/${"p".repeat(files_PATH_MAX_LENGTH - 1)}`;
	const nodeId = await f.t.run(
		async (ctx) => (await insert_saved_node(ctx, f.db, { parent: null, name: "max", kind: "file" }))._id,
	);
	await f.t.run(async (ctx) => {
		for (const namespace of ["frontmatter", "metadata"] as const)
			for (let key = 0; key < 128; key++) {
				const prefix = `${namespace}.k${key}-`;
				const base = {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					sourceKind: "committed" as const,
					fileNodeId: nodeId,
					path,
					treePath: path,
					fieldPath: prefix + "x".repeat(160 - prefix.length),
				};
				const name = "n".repeat(files_NAME_MAX_LENGTH);
				await ctx.db.insert("files_metadata_docs", {
					...base,
					docKind: "field",
					parentId: "root",
					name,
					sortName: name,
				});
				for (let value = 0; value < (namespace === "frontmatter" ? 3 : 2); value++)
					await ctx.db.insert("files_metadata_docs", {
						...base,
						docKind: "value",
						valueKind: "string",
						stringValue: `${value}${(value % 2 ? "文" : "v").repeat(1023)}`,
					});
			}
	});
	const { peaks, record } = budget_recorder();
	test_spy_handler(migrate_metadata_doc_area, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		record("batch", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});

	const status = await f.t.action((ctx) =>
		runToCompletion(ctx, components.migrations, internal.migrations.migrate_metadata_doc_area),
	);
	expect(status.state).toBe("success");
	expect((await committed_docs(f)).every((doc) => doc.restrictedScopeNodeId === null)).toBe(true);
	const peak = peaks.get("batch")!;
	console.info("metadata doc area backfill peak batch", JSON.stringify(peak));
	expect(peak.calls).toBeGreaterThanOrEqual(9);
	// A batch of 100 reads about 1 MiB and writes less, of the 16 MiB limits.
	expect(peak.measured.bytesRead).toBeLessThan(2 * 1024 * 1024);
	expect(peak.measured.bytesWritten).toBeLessThan(2 * 1024 * 1024);
	expect(peak.measured.documentsWritten).toBeLessThan(400);
});
