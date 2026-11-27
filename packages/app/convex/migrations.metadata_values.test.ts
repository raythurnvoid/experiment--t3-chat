import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { beforeEach, afterEach, vi, expect, test } from "vitest";
import { files_index_db_request } from "../server/files-index.ts";
import { create_fixture, create_folder } from "./files_move_scale.setup.test.ts";
import { stage_metadata } from "./files_index.ts";
import type { FunctionArgs } from "convex/server";
import { test_spy_handler } from "./setup.test.ts";
import { api, internal } from "./_generated/api.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_file_index,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { files_metadata_typed_fields } from "../server/files-metadata-index.ts";
import { search_saved_metadata_all } from "./files_nodes.setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: Date.UTC(2026, 10, 27) });
	mock_nodes_content_storage();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("a folder equality lookup refuses a value longer than the physical key prefix", async () => {
	const t = test_convex({ transactionLimits: true });
	const { membershipId, userId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const value = "界".repeat(1024);
	expect(new TextEncoder().encode(value).length).toBe(3072);
	const asWho = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	for (const folder of ["inside", "outside"]) {
		const node = await test_create_saved_text_file(t, {
			membershipId,
			path: "/" + folder + "/sample.md",
			textContent: "---\nlabel: " + value + "\n---\nBody",
		});
		await test_finish_file_index(t, node);
	}
	await expect(
		search_saved_metadata_all({
			asWho,
			membershipId,
			folderPath: "/inside",
			plan: { op: "eq", fieldPath: "frontmatter.label", value },
		}),
	).rejects.toThrow("too long together to search only /inside");
});

test("strip preserves false and zero and the preview rolls back", async ({ task }) => {
	const t = test_convex({ transactionLimits: true });
	const { membershipId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const node = await test_create_saved_text_file(t, {
		membershipId,
		path: "/sample.md",
		textContent: "---\nactive: false\nnumber: 0\ndate: 2026-01-01\n---\nBody",
	});
	await test_finish_file_index(t, node);
	const read = () => t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
	for (const doc of await read())
		await t.run((ctx) => ctx.db.patch("files_metadata_docs", doc._id, files_metadata_typed_fields(doc)));
	const args = { table: "files_metadata_docs" as const, cursor: null, cutoff: Date.now() + 1000 };
	const before = await t.query(internal.migrations.audit_metadata_values, { ...args, digest: "", layout: "original" });
	await expect(
		t.mutation(internal.migrations.migrate_metadata_values, { ...args, operation: "strip", preview: true }),
	).rejects.toThrow("Metadata preview rolled back");
	expect((await read()).some((row) => row.booleanValue === false)).toBe(true);
	const result = await t.mutation(internal.migrations.migrate_metadata_values, {
		...args,
		operation: "strip",
		preview: false,
	});
	Object.assign(task.meta, { migration: result });
	expect((await read()).filter((row) => row.docKind === "value").map((row) => row.searchValue)).toEqual(
		expect.arrayContaining([false, 0, "2026-01-01", Date.UTC(2026, 0, 1)]),
	);
	const after = await t.query(internal.migrations.audit_metadata_values, { ...args, digest: "", layout: "strict" });
	expect(after.digest).toBe(before.digest);
	expect(
		(await t.mutation(internal.migrations.migrate_metadata_values, { ...args, operation: "strip", preview: false }))
			.changed,
	).toBe(0);
});

test("an old action and a queued candidate finish the same index run", async () => {
	const t = test_convex({ transactionLimits: true });
	const { membershipId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const node = await test_create_saved_text_file(t, {
		membershipId,
		path: "/old.md",
		textContent: "---\nflag: false\n---\ntext",
	});
	await test_finish_file_index(t, node);
	await t.run((ctx) => files_index_db_request(ctx, { nodeId: node, contentChanged: false }));
	test_spy_handler(stage_metadata, async (handler, ctx, raw) => {
		const args = raw as FunctionArgs<typeof internal.files_index.stage_metadata>;
		return handler(ctx, {
			...args,
			values: args.values.map(({ searchValue, ...doc }) => ({
				...doc,
				...files_metadata_typed_fields({ searchValue }),
			})),
		});
	});
	let checked = false;
	await test_finish_file_index(t, node, async (phase) => {
		if (phase !== "ready" || checked) return;
		const item = await t.run(async (ctx) =>
			(await ctx.db.query("files_index_candidates").collect()).find(
				(r) => r.kind === "metadata" && r.value.valueKind === "boolean",
			),
		);
		if (!item || item.kind !== "metadata") throw Error("Missing staged boolean");
		expect(item.value.searchValue, "a bridge action stages the combined value").toBe(false);
		const run = await t.run((ctx) => ctx.db.get("files_index_runs", item.runId));
		const legacy = { ...item.value };
		legacy.booleanValue = false;
		await t.run((ctx) => ctx.db.patch("files_index_candidates", item._id, { value: legacy }));
		const page = { table: "files_index_candidates" as const, cursor: null, cutoff: Date.now() + 1000 };
		const before = await t.query(internal.migrations.audit_metadata_values, {
			...page,
			layout: "original",
			digest: "",
		});
		expect(
			(
				await t.mutation(internal.migrations.migrate_metadata_values, {
					...page,
					operation: "strip",
					preview: false,
				})
			).changed,
		).toBe(1);
		expect(
			(await t.query(internal.migrations.audit_metadata_values, { ...page, layout: "strict", digest: "" })).digest,
		).toBe(before.digest);
		expect(await t.run((ctx) => ctx.db.get("files_index_runs", item.runId))).toEqual(run);
		// An install can claim a candidate before the backfill reaches it.
		await t.run((ctx) => ctx.db.patch("files_index_candidates", item._id, { value: legacy }));
		checked = true;
	});
	expect(checked).toBe(true);
	const rows = await t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
	expect(
		rows.filter((r) => r.valueKind === "boolean").map((r) => r.searchValue),
		"old candidate publishes its false value",
	).toEqual([false]);
});

test("a heavy batch preserves the owner, revision and view of draft rows", async ({ task }) => {
	const t = test_convex({ transactionLimits: true });
	const { organizationId, workspaceId, userId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const proposal = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId,
		workspaceId,
		userId,
		path: "/draft.md",
		kind: "file",
	});
	if (!proposal._yay || !proposal._yay.pendingUpdateId) throw Error("Missing private draft");
	const { target, pendingUpdateId } = proposal._yay;
	const text = "界".repeat(1025);
	await t.run(async (ctx) => {
		for (let i = 0; i < 32; i++)
			await ctx.db.insert("files_metadata_docs", {
				organizationId,
				workspaceId,
				userId,
				sourceKind: "pending",
				target,
				pendingUpdateId,
				proposalRevision: 1,
				path: "/draft.md",
				treePath: "/draft.md",
				fieldPath: "frontmatter.key" + i,
				docKind: "value",
				valueKind: "string",
				stringValue: text,
				searchValue: text,
			});
	});
	const args = { table: "files_metadata_docs" as const, cursor: null, cutoff: Date.now() + 1000 };
	const before = await t.query(internal.migrations.audit_metadata_values, { ...args, digest: "", layout: "original" });
	const batch = await t.mutation(internal.migrations.migrate_metadata_values, {
		...args,
		operation: "strip",
		preview: false,
	});
	expect(batch.changed).toBe(32);
	expect(batch.bytesWritten.used).toBeLessThan(512 * 1024);
	Object.assign(task.meta, { heavy: batch });
	const after = await t.query(internal.migrations.audit_metadata_values, { ...args, digest: "", layout: "strict" });
	expect(after.digest).toBe(before.digest);
});

test("a queued Move blocks the first batch before its cohort exists", async () => {
	const fixture = await create_fixture();
	const source = await create_folder(fixture, "/source");
	const target = await create_folder(fixture, "/target");
	const started = await fixture.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: fixture.db.membershipId,
		requestId: "partial-move",
		kind: "move",
		expectedSourceCount: 2,
		sourceIds: [source._id],
		targetParentId: target._id,
	});
	expect(started._nay).toBeUndefined();
	expect(
		await fixture.t.run(async (ctx) =>
			(await ctx.db.query("files_move_cohorts").collect()).filter((row) => row.phase !== "complete"),
		),
	).toEqual([]);
	await expect(
		fixture.t.mutation(internal.migrations.migrate_metadata_values, {
			table: "files_metadata_docs",
			cursor: null,
			cutoff: Date.now(),
			operation: "strip",
			preview: false,
		}),
	).rejects.toThrow("Wait for active Moves to finish");
});
