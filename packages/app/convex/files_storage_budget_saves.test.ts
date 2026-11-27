import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { mock_nodes_content_storage, objects } from "./files_nodes_content.setup.test.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import {
	normalize_pending_update_markdown,
	upsert_file_pending_update_public_for_test,
} from "./files_pending_updates.setup.test.ts";
import {
	test_finish_storage_cleanup,
	test_retire_storage_head,
	test_storage_delta,
	test_storage_snapshot,
} from "./files_storage_budget.setup.test.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_create_saved_text_file,
	test_finish_file_index,
	test_mocks_fill_db_with,
} from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: Date.UTC(2026, 10, 27) });
	mock_nodes_content_storage();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		objects.delete(key);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function saved_file() {
	const t = test_convex({ transactionLimits: true });
	const { userId, membershipId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	const before = await test_storage_snapshot(t);
	const nodeId = await test_create_saved_text_file(t, {
		membershipId,
		path: "/notes.md",
		textContent: "# Meeting\n\n" + "We discussed the numbers and the next steps. ".repeat(90).trim(),
	});
	const args = { membershipId, nodeId };
	expect(
		await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			...args,
			acknowledgeDropCollaborativeHistory: true,
		}),
	).toHaveProperty("_yay");
	await test_finish_file_index(t, nodeId);
	await test_finish_storage_cleanup(t);
	await test_compact_metadata_catalog(t);
	const read = async () => {
		const result = await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, args);
		if (result._nay) throw new Error(result._nay.message);
		return result._yay.text;
	};
	const save = (requestId: string, text: string) =>
		asUser.action(api.files_nodes_content.replace_file_content, { ...args, requestId, text });
	const head = () => t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!.contentHeadId!);
	const cleanup = async (headId: Id<"files_saved_content_heads">) => {
		await test_finish_file_index(t, nodeId);
		await test_retire_storage_head(t, headId);
		await test_finish_storage_cleanup(t);
		if (headId !== (await head())) {
			await t.run(async (ctx) => {
				const oldExact = await ctx.db
					.query("files_text_chunks")
					.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", headId))
					.collect();
				expect(oldExact, "cleanup releases the old exact text").toHaveLength(0);
				const searchRows = await ctx.db.query("files_plain_text_chunks").collect();
				expect(searchRows.some((row) => row.sourceKind === "committed" && row.contentHeadId === headId)).toBe(false);
			});
		}
		await test_compact_metadata_catalog(t);
		await t.run(async (ctx) => {
			for (const table of ["files_index_runs", "files_index_inputs", "files_index_candidates"] as const)
				expect(await ctx.db.query(table).first(), table).toBeNull();
		});
	};
	const measure = async (text: string, label: string, limit: number) => {
		const delta = test_storage_delta(before, await test_storage_snapshot(t));
		const ratio = delta.billedBytes / files_get_utf8_byte_size(text);
		expect.soft(ratio, `${label}: ${ratio.toFixed(3)}×\n${delta.report}`).toBeLessThanOrEqual(limit);
	};
	return { t, asUser, args, read, save, head, cleanup, measure };
}

test.each(["one character changed", "same bytes"])(
	"Save with %s keeps one current text within budget",
	async (edit) => {
		const f = await saved_file();
		const oldHead = await f.head();
		const initial = await f.read();
		const next = edit === "same bytes" ? initial : initial + "!";
		const versions = () => f.t.run(async (ctx) => (await ctx.db.query("files_snapshots").collect()).length);
		const before = await versions();
		expect(await f.save("edit", next)).toHaveProperty("_yay");
		await f.cleanup(oldHead);
		expect(await versions(), "a new Save adds one file version").toBe(before + 1);
		expect(await f.read()).toBe(next);
		await f.measure(next, edit, 98);
	},
);

test("storage while a draft is open on the saved file", async () => {
	const f = await saved_file();
	const initial = await f.read();
	const draft = initial + " Draft.";
	expect(
		await upsert_file_pending_update_public_for_test(f.asUser, {
			...f.args,
			stagedMarkdown: initial,
			unstagedMarkdown: draft,
		}),
	).toHaveProperty("_yay");
	expect(await f.read()).toBe(initial);
	await test_finish_storage_cleanup(f.t);
	await test_compact_metadata_catalog(f.t);
	await f.t.run(async (ctx) => {
		const exact = (await ctx.db.query("files_text_chunks").collect())
			.filter((doc) => doc.sourceKind === "pending")
			.sort((a, b) => a.chunkIndex - b.chunkIndex);
		const chunks = (await ctx.db.query("files_plain_text_chunks").collect()).filter(
			(doc) => doc.sourceKind === "pending",
		);
		expect(exact.map((doc) => doc.textChunk).join("")).toBe(normalize_pending_update_markdown(draft));
		expect(chunks.some((doc) => doc.plainTextChunk.includes("Draft."))).toBe(true);
	});
	await f.measure(initial + draft, "saved and draft bytes", 85);
});

test.each(["rejected", "committed"])("storage when a waiting Save is %s", async (outcome) => {
	const f = await saved_file();
	const initial = await f.read();
	const oldHead = await f.head();
	const first = initial + " First.";
	const second = initial + " Second.";
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const capturedFetch = fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "PUT" && init.body === first) {
			entered.resolve();
			await resume.promise;
		}
		return capturedFetch(input, init);
	});
	const waiting = f.save("waiting", first);
	try {
		await Promise.race([
			entered.promise,
			waiting.then((result) => {
				throw new Error(`Save finished before its upload: ${JSON.stringify(result)}`);
			}),
		]);
		if (outcome === "rejected") {
			expect(await f.asUser.mutation(api.files_nodes.read_only_set, { ...f.args, readOnly: true })).toHaveProperty(
				"_yay",
			);
			resume.resolve();
			expect(await waiting).toMatchObject({ _nay: { name: "read_only" } });
			expect(await f.read()).toBe(initial);
			const request = await f.t.run((ctx) => ctx.db.query("files_content_save_requests").unique());
			if (request?.progress.state !== "ready" || request.expiresAt === null)
				throw new Error("Expected a hidden candidate");
			await f.measure(initial, "rejected before cleanup", 120);
			vi.setSystemTime(request.expiresAt + 1);
			await f.t.mutation(internal.files_content_saves.expire, { saveId: request._id });
			await f.cleanup(request.progress.headId);
			const jobs = await f.t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
			expect(jobs.length).toBeGreaterThan(0);
			for (const job of jobs)
				await f.t.action(internal.r2_client.process_object_deletion_job, {
					jobId: job._id,
					generation: job.generation,
				});
			expect(await f.t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").first())).toBeNull();
			expect(await f.read()).toBe(initial);
			await f.measure(initial, "rejected after cleanup", 98);
		} else {
			expect(await f.save("second", second)).toHaveProperty("_yay");
			expect(await f.read()).toBe(second);
			const secondHead = await f.head();
			resume.resolve();
			expect(await waiting).toHaveProperty("_yay");
			expect(await f.read(), "the last commit wins even though its upload began first").toBe(first);
			await f.measure(first, "both Saves committed before cleanup", 143);
			await f.cleanup(oldHead);
			await f.cleanup(secondHead);
			await f.measure(first, "both Saves committed after cleanup", 99);
		}
	} finally {
		resume.resolve();
		await waiting;
	}
});
