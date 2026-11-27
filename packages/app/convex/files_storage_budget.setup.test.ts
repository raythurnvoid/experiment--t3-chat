import { getDocumentSize } from "convex/values";
import { expect } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id, TableNames } from "./_generated/dataModel.js";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import schema from "./schema.ts";
import type { test_convex } from "./setup-base.test.ts";

// This estimate covers app tables. Component storage and I/O from mocked R2 and Workpool calls are outside it.
const { tables } = JSON.parse((schema as unknown as { export: () => string }).export()) as {
	tables: Array<{ tableName: TableNames; indexes: unknown[]; searchIndexes: unknown[]; vectorIndexes: unknown[] }>;
};

export async function test_storage_snapshot(t: ReturnType<typeof test_convex>) {
	const sizes = new Map<TableNames, { rows: number; docBytes: number; copies: number }>();
	let searchChars = 0;
	let searchBytes = 0;
	for (const table of tables) {
		const size = await t.run(async (ctx) => {
			const rows = await ctx.db.query(table.tableName).collect();
			let docBytes = 0;
			for (const row of rows) {
				docBytes += getDocumentSize(row);
				if (table.tableName === "files_plain_text_chunks" && "plainTextChunk" in row) {
					searchChars += row.plainTextChunk.length;
					searchBytes += files_get_utf8_byte_size(row.plainTextChunk);
				}
			}
			return { rows: rows.length, docBytes };
		});
		// Convex bills one full document copy per declared index. System indexes are free.
		const copies = 1 + table.indexes.length + table.searchIndexes.length + table.vectorIndexes.length;
		sizes.set(table.tableName, { ...size, copies });
	}
	return { sizes, searchChars, searchBytes };
}

export function test_storage_delta(
	before: Awaited<ReturnType<typeof test_storage_snapshot>>,
	after: Awaited<ReturnType<typeof test_storage_snapshot>>,
) {
	const tables = Array.from(after.sizes, ([name, size]) => {
		const baseline = before.sizes.get(name)!;
		const docBytes = size.docBytes - baseline.docBytes;
		return { name, rows: size.rows - baseline.rows, docBytes, copies: size.copies, billed: docBytes * size.copies };
	}).filter((table) => table.rows || table.docBytes);
	const billedBytes = tables.reduce((sum, table) => sum + table.billed, 0);
	const report = tables
		.sort((a, b) => b.billed - a.billed)
		.map(({ name, rows, docBytes, copies, billed }) => {
			const percent = billedBytes ? (100 * billed) / billedBytes : 0;
			return `${name} docs=${rows} docBytes=${docBytes} copies=${copies} billed=${billed} (${percent.toFixed(1)}%)`;
		})
		.join("\n");
	const searchRows =
		after.sizes.get("files_plain_text_chunks")!.rows - before.sizes.get("files_plain_text_chunks")!.rows;
	return {
		billedBytes,
		report,
		meanSearchChunkLength: searchRows ? (after.searchChars - before.searchChars) / searchRows : 0,
		meanSearchChunkBytes: searchRows ? (after.searchBytes - before.searchBytes) / searchRows : 0,
	};
}

export async function test_retire_storage_head(
	t: ReturnType<typeof test_convex>,
	headId: Id<"files_saved_content_heads">,
) {
	await t.mutation(internal.files_content_saves.retire, { headId });
	// A live history owner can still protect this head.
	if (!(await t.run((ctx) => ctx.db.get("files_saved_content_heads", headId)))?.retired) return;
	for (let pass = 0; pass < 100; pass++) {
		const chunk = await t.run((ctx) =>
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", headId))
				.first(),
		);
		await t.mutation(internal.files_content_saves.discard, { headId });
		if (!chunk) return;
	}
	throw new Error("Old text cleanup did not finish");
}

/**
 * Finish immediate Save cleanup without advancing retention deadlines or running unrelated jobs.
 */
export async function test_finish_storage_cleanup(t: ReturnType<typeof test_convex>) {
	for (let pass = 0; pass < 100; pass++) {
		const result = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_disableReschedule: true,
		});
		if (result.done) break;
		if (pass === 99) throw new Error("Retired draft cleanup did not finish");
	}
	const tasks = await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect());
	for (const task of tasks) {
		for (let pass = 0; pass < 100; pass++) {
			await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
			if (!(await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))) break;
			if (pass === 99) throw new Error("File history cleanup did not finish");
		}
		if (task.logOwnerId) await test_retire_storage_head(t, task.logOwnerId);
	}
	await t.run(async (ctx) => {
		expect(await ctx.db.query("files_pending_update_state_cleanup_tasks").first()).toBeNull();
		expect(await ctx.db.query("files_yjs_cleanup_tasks").first()).toBeNull();
	});
}
