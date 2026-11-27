import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { begin, discard, publish, retire, seal, stage_page } from "./files_content_saves.ts";
import { advance, stage_metadata, start } from "./files_index.ts";
import { compact_metadata_catalog } from "./files_pending_overlay.ts";
import {
	test_finish_storage_cleanup,
	test_retire_storage_head,
	test_storage_delta,
	test_storage_snapshot,
} from "./files_storage_budget.setup.test.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_metadata_preflight_frontmatter } from "../shared/files-metadata.ts";
import { files_metadata_value_doc_payload } from "./files_metadata_db.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_create_saved_text_file,
	test_finish_file_index,
	test_mocks_fill_db_with,
	test_spy_handler,
} from "./setup.test.ts";

// Round up the settled corpus measurements. Lower both limits when storage falls.
const BUDGET_TOTAL = 90;
const BUDGET_PER_BYTE = 36;

beforeEach(() => {
	vi.useFakeTimers({ now: Date.UTC(2026, 10, 27) });
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/**
 * Count the writes of each Save and index step, including patches and deletes. Stored bytes
 * alone cannot show how many times the indexer wrote the same doc before cleanup.
 */
function measure_save_writes(measuring: () => boolean) {
	const steps: Record<string, { calls: number; documentsWritten: number; bytesWritten: number }> = {};
	for (const [name, mutation] of Object.entries({
		begin,
		stage_page,
		seal,
		publish,
		retire,
		discard,
		start,
		stage_metadata,
		advance,
		compact_metadata_catalog,
	})) {
		test_spy_handler(mutation, async (handler, ctx, args) => {
			if (!measuring()) return await handler(ctx, args);
			let step = name;
			if (mutation === advance) {
				const { runId } = args as { runId: Id<"files_index_runs"> };
				const run = await ctx.db.get("files_index_runs", runId);
				if (run) step = `index/${run.phase}`;
			}
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			const after = await ctx.meta.getTransactionMetrics();
			const total = (steps[step] ??= { calls: 0, documentsWritten: 0, bytesWritten: 0 });
			total.calls++;
			total.documentsWritten += after.documentsWritten.used - before.documentsWritten.used;
			total.bytesWritten += after.bytesWritten.used - before.bytesWritten.used;
			return result;
		});
	}
	return steps;
}

function markdown(file: number, size: number, bodyCopies: number, extraKeys: number) {
	const frontmatter = [
		"---",
		`title: Planning meeting ${file}`,
		"team: engineering",
		"owner: Lee",
		"location: London",
		`attendees: ${file + 2}`,
		"published: true",
		"tags: [weekly, planning, product, engineering]",
		'created: "2026-11-03"',
		'updated: "2026-11-10"',
		...Array.from({ length: extraKeys }, (_, key) => `property${key}: meeting note ${key}`),
		"---",
		"",
	].join("\n");
	let body =
		"# Meeting notes\n\n- Review\n- Follow up\n\n| Item | Owner |\n| --- | --- |\n| Review | Lee |\n\n```js\ncheck();\n```\n\n";
	const topics = ["search", "files", "drafts", "storage", "review"];
	for (let line = 0; frontmatter.length + body.length < size; line++) {
		if (line % 12 === 0) body += `\n## Agenda ${line + 1}\n\n`;
		body += `The team discussed ${topics[(file + line) % topics.length]} and recorded the next steps for item ${line + 1}.\n\n`;
	}
	return frontmatter + body.repeat(bodyCopies);
}

async function measure_corpus(sizes: number[], bodyCopies = 1, extraKeys = 0, measureSave = false) {
	const t = test_convex({ transactionLimits: true });
	const { membershipId, userId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	const before = await test_storage_snapshot(t);
	let markdownBytes = 0;
	let beforeCleanupBytes = 0;
	let measuring = false;
	const savedText = new Map<Id<"files_nodes">, string>();
	const writes = measureSave ? measure_save_writes(() => measuring) : null;
	for (const [file, size] of sizes.entries()) {
		const text = markdown(file, size, bodyCopies, extraKeys);
		const nodeId = await test_create_saved_text_file(t, {
			membershipId,
			path: `/customer-meeting-archive/product-engineering-team/weekly-planning-records/meeting-notes-${file}.md`,
			textContent: text,
		});
		await test_finish_file_index(t, nodeId);
		expect(
			await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toHaveProperty("_yay");
		const headId = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!.contentHeadId!);
		const changed = text.replace("Meeting notes", "Meeting Notes");
		savedText.set(nodeId, changed);
		await test_compact_metadata_catalog(t);
		await test_finish_storage_cleanup(t);
		const beforeSave = measureSave ? await test_storage_snapshot(t) : null;
		measuring = measureSave;
		expect(
			await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId,
				nodeId,
				requestId: `budget-${file}`,
				text: changed,
			}),
		).toHaveProperty("_yay");
		let sampled = false;
		await test_finish_file_index(t, nodeId, async (phase) => {
			// Both versions and all candidates still exist just before the first cleanup step.
			if (beforeSave && !sampled && phase === "cleanup_text") {
				const { billedBytes } = test_storage_delta(beforeSave, await test_storage_snapshot(t));
				beforeCleanupBytes = Math.max(beforeCleanupBytes, billedBytes);
				sampled = true;
			}
		});
		await test_retire_storage_head(t, headId);
		await test_compact_metadata_catalog(t);
		measuring = false;
		if (measureSave) expect(sampled, "every replacement reached index cleanup").toBe(true);
		markdownBytes += files_get_utf8_byte_size(changed);
	}
	await test_compact_metadata_catalog(t);
	await test_finish_storage_cleanup(t);
	await t.run(async (ctx) => {
		// A missing search or frontmatter doc would make the file look cheaper.
		const searchDocs = (await ctx.db.query("files_plain_text_chunks").collect()).filter(
			(doc) => doc.sourceKind === "committed",
		);
		const metadataDocs = (await ctx.db.query("files_metadata_docs").collect()).filter(
			(doc) => doc.sourceKind === "committed",
		);
		const exactDocs = (await ctx.db.query("files_text_chunks").collect()).filter(
			(doc) => doc.sourceKind === "committed",
		);
		for (const [nodeId, text] of savedText) {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			const chunks = searchDocs.filter((doc) => doc.fileNodeId === nodeId).sort((a, b) => a.chunkIndex - b.chunkIndex);
			const exact = exactDocs.filter((doc) => doc.fileNodeId === nodeId).sort((a, b) => a.chunkIndex - b.chunkIndex);
			const fields = metadataDocs.filter((doc) => doc.fileNodeId === nodeId);
			const search = await files_chunk_markdown(text);
			const extracted = files_metadata_preflight_frontmatter(text);
			if (search._nay || extracted._nay) throw new Error("Expected valid Markdown with frontmatter");
			expect(exact.map((doc) => doc.textChunk).join("")).toBe(text);
			expect(chunks.map((doc) => doc.plainTextChunk)).toEqual(search._yay.map((chunk) => chunk.plainTextChunk));
			expect(fields).toHaveLength(extracted._yay.indexDocumentCount);
			for (const fieldPath of extracted._yay.metadata.fields)
				expect(fields).toContainEqual(expect.objectContaining({ docKind: "field", fieldPath }));
			for (const value of extracted._yay.metadata.values)
				expect(fields).toContainEqual(
					expect.objectContaining({ fieldPath: value.fieldPath, ...files_metadata_value_doc_payload(value) }),
				);
			for (const doc of [...exact, ...chunks, ...fields]) expect(doc.contentHeadId).toBe(node.contentHeadId);
		}
		for (const table of [
			"files_index_candidates",
			"files_index_runs",
			"files_index_inputs",
			"files_pending_update_yjs_states",
			"files_pending_update_yjs_state_pages",
		] as const) {
			expect(await ctx.db.query(table).first(), table).toBeNull();
		}
	});
	const saveWrites = JSON.stringify(writes);
	if (writes) {
		expect(writes["index/publish"]?.documentsWritten, saveWrites).toBeGreaterThan(0);
		expect(writes.stage_page?.documentsWritten, saveWrites).toBeGreaterThan(0);
	}
	return {
		...test_storage_delta(before, await test_storage_snapshot(t)),
		markdownBytes,
		beforeCleanupBytes,
		saveWrites,
	};
}

test("keeps saved Markdown within the total and per-byte storage budgets", async ({ task }) => {
	const sizes = [1, 1, 1, 1, 4, 4, 4, 4, 12, 12, 32, 32].map((kb) => kb * 1024);
	const regular = await measure_corpus(sizes, 1, 0, true);
	const doubled = await measure_corpus(sizes, 2);
	const tiny = await measure_corpus(Array<number>(12).fill(350));
	const manyKeys = await measure_corpus([4096, 4096, 4096, 4096], 1, 25);
	const total = regular.billedBytes / regular.markdownBytes;
	const marginal = (doubled.billedBytes - regular.billedBytes) / (doubled.markdownBytes - regular.markdownBytes);
	const report = [
		`Mixed files: ${regular.markdownBytes} Markdown bytes, ${regular.billedBytes} database bytes, total ${total}, marginal ${marginal}.`,
		`Doubled bodies: ${doubled.markdownBytes} Markdown bytes, ${doubled.billedBytes} database bytes.`,
		`Tiny files: ${tiny.billedBytes / 12} database bytes per file.`,
		`Extra metadata: ${manyKeys.billedBytes / 4} database bytes per file.`,
		`Mean search chunk: ${regular.meanSearchChunkBytes} bytes, ${regular.meanSearchChunkLength} characters.`,
		`Largest increase from one replacement before text cleanup: ${regular.beforeCleanupBytes} estimated billed bytes. Writes by step for all replacements: ${regular.saveWrites}`,
		regular.report,
	].join("\n");
	// The JSON reporter keeps measurements from passing runs too.
	Object.assign(task.meta, { storageBudget: report });
	expect.soft(total, report).toBeLessThanOrEqual(BUDGET_TOTAL);
	expect(marginal, report).toBeLessThanOrEqual(BUDGET_PER_BYTE);
}, 240_000);
