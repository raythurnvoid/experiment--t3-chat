import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { fixture } from "./files_pending_overlay.setup.test.ts";
import { mock_nodes_content_storage, objects } from "./files_nodes_content.setup.test.ts";
import {
	test_create_saved_text_file,
	test_finish_file_index,
	test_finish_saved_scope_jobs,
	test_max_chunks_markdown,
} from "./setup.test.ts";
import { seed_billing_snapshot_for_user } from "./files_nodes.setup.test.ts";
import { upsert_file_pending_update_public_for_test } from "./files_pending_updates.setup.test.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_preflight_frontmatter,
} from "../shared/files-metadata.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function create_file(path = "/save.md", text = "Original text\n") {
	const f = await fixture(true);
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path,
		textContent: text,
	});
	expect(
		await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: f.db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		}),
		"the native fixture reaches collaboration off before Save",
	).toHaveProperty("_yay");
	return { ...f, nodeId, path };
}

async function read_history(f: Awaited<ReturnType<typeof create_file>>) {
	return await f.t.run(async (ctx) => {
		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q.eq("organizationId", f.u.organizationId).eq("workspaceId", f.u.workspaceId).eq("fileNodeId", f.nodeId),
			)
			.collect();
		return await Promise.all(
			snapshots.map(async (snapshot) => ({
				snapshot,
				asset: await ctx.db.get("files_r2_assets", snapshot.assetId),
			})),
		);
	});
}

async function expect_saved_text(f: Awaited<ReturnType<typeof create_file>>, text: string) {
	const read = await f.asU.query(api.files_nodes_content.get_non_collaborative_file_content, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
	});
	expect(read._yay?.text, "reopening reads the complete saved source").toBe(text);
	const apiRead = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		...f.u,
		subject: { kind: "user", userId: f.u.userId, plugin: null },
		path: f.path,
		includePending: false,
	});
	expect(apiRead?.content, "the file API reads the complete saved source").toBe(text);
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId));
	const asset = node?.assetId ? await f.t.run((ctx) => ctx.db.get("files_r2_assets", node.assetId!)) : null;
	expect(asset?.r2Key ? objects.get(asset.r2Key) : undefined, "the saved object holds the exact source bytes").toBe(
		text,
	);
}

test("Save publication rechecks a lock added during upload", async () => {
	const f = await create_file();
	const before = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId));
	const history = await read_history(f);
	const uploaded = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const capturedFetch = fetch;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const response = await capturedFetch(input, init);
			if (init?.method === "PUT" && init.body === "Replacement text\n") {
				uploaded.resolve();
				await resume.promise;
			}
			return response;
		}),
	);
	const saving = f.asU.action(api.files_nodes_content.replace_file_content, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		requestId: "lock-during-upload",
		text: "Replacement text\n",
	});
	await uploaded.promise;
	try {
		expect(
			await f.asU.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				writePolicy: { mode: "read_only" },
			}),
		).toHaveProperty("_yay");
		resume.resolve();
		expect(await saving, "publication refuses the lock added after Save began").toMatchObject({
			_nay: { name: "read_only", message: "This item is read-only." },
		});
		const request = await f.t.run((ctx) =>
			ctx.db
				.query("files_content_save_requests")
				.withIndex("by_user_workspace_request", (q) =>
					q.eq("userId", f.u.userId).eq("workspaceId", f.u.workspaceId).eq("requestId", "lock-during-upload"),
				)
				.unique(),
		);
		if (request?.progress.state !== "ready") throw new Error("Expected a complete unpublished Save");
		expect(
			await f.t.mutation(internal.files_content_saves.publish, {
				saveId: request._id,
				generation: request.progress.generation,
			}),
			"repeating publication still checks the current lock",
		).toMatchObject({ _nay: { name: "read_only" } });
		const assetId = request.progress.assetId;
		const after = await f.t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", f.nodeId),
			asset: await ctx.db.get("files_r2_assets", assetId),
		}));
		expect(after.node?.assetId).toBe(before?.assetId);
		expect(after.asset?.r2Key).toBeUndefined();
		expect(after.asset?.unfinalizedExpiresAt).toBeDefined();
		expect(await read_history(f)).toEqual(history);
		await expect_saved_text(f, "Original text\n");
	} finally {
		resume.resolve();
		await saving;
	}
});

test("retry after a lost reply keeps the newer Save and does not charge or write history twice", async () => {
	const f = await create_file();
	const firstArgs = { membershipId: f.db.membershipId, nodeId: f.nodeId, requestId: "save-a", text: "First Save\n" };
	const first = await f.asU.action(api.files_nodes_content.replace_file_content, firstArgs);
	expect(first._nay).toBeUndefined();
	const second = await f.asU.action(api.files_nodes_content.replace_file_content, {
		...firstArgs,
		requestId: "save-b",
		text: "Second Save\n",
	});
	expect(second._nay).toBeUndefined();
	expect(second._yay?.contentRevision).toBeGreaterThan(first._yay!.contentRevision);
	const before = await f.t.run(async (ctx) => ({
		node: await ctx.db.get("files_nodes", f.nodeId),
		charges: await ctx.db.query("billing_usage_event_outbox").collect(),
	}));
	const history = await read_history(f);
	const objectCount = objects.size;

	// The first reply never reached the editor. Its retry is still the same Save.
	const retry = await f.asU.action(api.files_nodes_content.replace_file_content, firstArgs);
	expect(retry, "a committed retry returns its original receipt").toEqual(first);
	await expect_saved_text(f, "Second Save\n");
	expect(await read_history(f), "a committed retry writes no new version").toEqual(history);
	expect(
		await f.t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", f.nodeId),
			charges: await ctx.db.query("billing_usage_event_outbox").collect(),
		})),
		"a committed retry changes neither the current file nor billing",
	).toEqual(before);
	expect(objects.size, "a committed retry uploads no new object").toBe(objectCount);
});

test("a Save request cannot be reused for changed text or a different file", async () => {
	const f = await create_file();
	const otherNodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/other.md",
		textContent: "Other file\n",
	});
	expect(
		await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: f.db.membershipId,
			nodeId: otherNodeId,
			acknowledgeDropCollaborativeHistory: true,
		}),
	).toHaveProperty("_yay");
	const args = { membershipId: f.db.membershipId, nodeId: f.nodeId, requestId: "fixed-request", text: "Saved text\n" };
	expect(await f.asU.action(api.files_nodes_content.replace_file_content, args)).toHaveProperty("_yay");
	const history = await read_history(f);
	const objectCount = objects.size;
	for (const changed of [
		{ ...args, text: "Different text\n" },
		{ ...args, nodeId: otherNodeId },
	]) {
		const refused = await f.asU.action(api.files_nodes_content.replace_file_content, changed);
		expect(refused._nay, "a changed request is refused before publication").toBeDefined();
	}
	await expect_saved_text(f, "Saved text\n");
	expect(
		await f.asU.query(api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId: f.db.membershipId,
			nodeId: otherNodeId,
		}),
	).toMatchObject({ _yay: { text: "Other file\n" } });
	expect(await read_history(f)).toEqual(history);
	expect(objects.size).toBe(objectCount);
});

test("overlapping retries publish one Save and cannot replace a later Save", async () => {
	const f = await create_file();
	const args = {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		requestId: "same-save",
		text: "First saved text\n",
	};
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const capturedFetch = fetch;
	let firstUpload = true;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (firstUpload && init?.method === "PUT" && init.body === args.text) {
				firstUpload = false;
				entered.resolve();
				await resume.promise;
			}
			return await capturedFetch(input, init);
		}),
	);
	const first = f.asU.action(api.files_nodes_content.replace_file_content, args);
	await entered.promise;
	try {
		const retry = await f.asU.action(api.files_nodes_content.replace_file_content, args);
		expect(retry._nay).toBeUndefined();
		expect(
			await f.asU.action(api.files_nodes_content.replace_file_content, {
				...args,
				requestId: "later-save",
				text: "Later saved text\n",
			}),
		).toHaveProperty("_yay");
		const history = await read_history(f);
		const charges = await f.t.run((ctx) => ctx.db.query("billing_usage_event_outbox").collect());
		resume.resolve();
		expect(await first, "the first upload returns the same receipt as its faster retry").toEqual(retry);
		await expect_saved_text(f, "Later saved text\n");
		expect(await read_history(f), "the delayed upload adds no second version").toEqual(history);
		expect(
			await f.t.run((ctx) => ctx.db.query("billing_usage_event_outbox").collect()),
			"the delayed upload adds no second charge",
		).toEqual(charges);
	} finally {
		resume.resolve();
		await first;
	}
});

test("two members using the same request string keep separate receipts", async () => {
	const f = await create_file();
	await f.t.run((ctx) => seed_billing_snapshot_for_user(ctx, f.v.userId));
	const firstArgs = {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		requestId: "same-string",
		text: "Owner text\n",
	};
	const first = await f.asU.action(api.files_nodes_content.replace_file_content, firstArgs);
	expect(first._nay).toBeUndefined();
	const second = await f.asV.action(api.files_nodes_content.replace_file_content, {
		...firstArgs,
		membershipId: f.vMember.membershipId,
		text: "Member text\n",
	});
	expect(second._nay).toBeUndefined();
	expect(second._yay?.contentRevision).toBeGreaterThan(first._yay!.contentRevision);
	expect(await f.asU.action(api.files_nodes_content.replace_file_content, firstArgs)).toEqual(first);
	await expect_saved_text(f, "Member text\n");
	const receipts = await f.t.run((ctx) =>
		ctx.db
			.query("files_content_save_requests")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", f.nodeId))
			.collect(),
	);
	expect(receipts.map((receipt) => receipt.userId).sort()).toEqual([f.u.userId, f.v.userId].sort());
});

test("Save is readable and silent while its search update waits", async () => {
	const oldText = "---\ntopic: before\n---\nOriginal text\n";
	const newText = "---\ntopic: after\n---\nSaved text\n";
	const f = await create_file("/search.md", oldText);
	await test_finish_file_index(f.t, f.nodeId);
	const before = await f.t.run(async (ctx) => ({
		node: await ctx.db.get("files_nodes", f.nodeId),
		activities: await ctx.db.query("activities").collect(),
	}));
	const metadataArgs = { ...f.u, subject: { kind: "user" as const, userId: f.u.userId, plugin: null }, path: f.path };
	const oldMetadata = await f.t.query(internal.files_metadata.get_index_values_by_path, metadataArgs);
	const saved = await f.asU.action(api.files_nodes_content.replace_file_content, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		requestId: "paused-search",
		text: newText,
	});
	expect(saved._nay).toBeUndefined();
	await expect_saved_text(f, newText);
	const download = await f.asU.action(api.r2.create_signed_download_url, {
		membershipId: f.db.membershipId,
		fileNodeId: f.nodeId,
	});
	if (download._nay) throw new Error(download._nay.message);
	expect(await (await fetch(download._yay.url)).text(), "download is current before indexing runs").toBe(newText);
	const waiting = await f.t.run((ctx) =>
		ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", f.nodeId))
			.first(),
	);
	expect(waiting?.requestedRevision, "Save leaves a durable request for background indexing").toBeGreaterThan(
		waiting!.publishedRevision,
	);
	expect(waiting?.publishedHeadId).toBe(before.node?.contentHeadId);
	expect(
		await f.t.query(internal.files_metadata.get_index_values_by_path, metadataArgs),
		"search keeps its last published result",
	).toEqual(oldMetadata);
	expect(await f.t.run((ctx) => ctx.db.query("activities").collect()), "indexing creates no Activity item").toEqual(
		before.activities,
	);
	await test_finish_file_index(f.t, f.nodeId);
	expect(await f.t.query(internal.files_metadata.get_index_values_by_path, metadataArgs)).toMatchObject({
		fields: ["frontmatter.topic"],
		values: [{ fieldPath: "frontmatter.topic", valueKind: "string", stringValue: "after" }],
	});
	expect(await f.t.run((ctx) => ctx.db.query("activities").collect())).toEqual(before.activities);
});

test("Save keeps and indexes every field beyond the old synchronous frontmatter cap", async () => {
	const f = await create_file();
	const fieldCount = files_metadata_MAX_FRONTMATTER_FIELDS + 5;
	const text = `---\n${Array.from({ length: fieldCount }, (_, index) => `field${index}: value${index}`).join("\n")}\n---\nBody\n`;
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			requestId: "all-frontmatter-fields",
			text,
		}),
	).toHaveProperty("_yay");
	await expect_saved_text(f, text);
	await test_finish_file_index(f.t, f.nodeId);
	const index = await f.t.query(internal.files_metadata.get_index_values_by_path, {
		...f.u,
		subject: { kind: "user", userId: f.u.userId, plugin: null },
		path: f.path,
	});
	expect(index?.fields, "all fields survive background indexing").toHaveLength(fieldCount);
	expect(index?.values, "all field values survive background indexing").toEqual(
		expect.arrayContaining(
			Array.from({ length: fieldCount }, (_, index) => ({
				fieldPath: `frontmatter.field${index}`,
				valueKind: "string",
				stringValue: `value${index}`,
			})),
		),
	);
	expect(index?.values).toHaveLength(fieldCount);
});

test("a receipt still prevents replay after its old history version is cleaned up", async () => {
	vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	const f = await create_file();
	const firstArgs = {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		requestId: "old-save",
		text: "First version\n",
	};
	const first = await f.asU.action(api.files_nodes_content.replace_file_content, firstArgs);
	expect(first._nay).toBeUndefined();
	await test_finish_file_index(f.t, f.nodeId);
	const firstHistory = (await read_history(f)).find(
		({ asset }) => asset?.r2Key && objects.get(asset.r2Key) === firstArgs.text,
	);
	if (!firstHistory) throw new Error("The first Save did not write history");
	const firstHeadId = await f.t.run(async (ctx) => (await ctx.db.get("files_nodes", f.nodeId))!.contentHeadId!);
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			...firstArgs,
			requestId: "new-save",
			text: "Newer version\n",
		}),
	).toHaveProperty("_yay");
	await test_finish_file_index(f.t, f.nodeId);
	await f.t.mutation(internal.files_content_saves.retire, { headId: firstHeadId });
	await f.t.mutation(internal.files_nodes.cleanup_old_snapshots, { now: Date.now() + 2 * 24 * 60 * 60 * 1000 });
	expect(
		await f.t.run((ctx) => ctx.db.get("files_snapshots", firstHistory.snapshot._id)),
		"history cleanup removed the old version before retry",
	).toBeNull();
	const history = await read_history(f);
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, firstArgs),
		"history expiry keeps the original receipt",
	).toEqual(first);
	await expect_saved_text(f, "Newer version\n");
	expect(await read_history(f)).toEqual(history);
});

test("Save and index cleanup keep another member's complete draft", async () => {
	const f = await create_file();
	expect(
		await upsert_file_pending_update_public_for_test(f.asV, {
			membershipId: f.vMember.membershipId,
			nodeId: f.nodeId,
			stagedMarkdown: "Original text\n",
			unstagedMarkdown: "Another member's draft\n",
		}),
	).toHaveProperty("_yay");
	const readDraft = () =>
		f.t.run(async (ctx) => ({
			proposal: await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.v.userId).eq("target.kind", "saved").eq("target.id", f.nodeId),
				)
				.first(),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
		}));
	const before = await readDraft();
	expect(before.proposal).not.toBeNull();
	expect(before.pages.length).toBeGreaterThan(0);
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			requestId: "save-beside-draft",
			text: "New saved text\n",
		}),
	).toHaveProperty("_yay");
	await test_finish_file_index(f.t, f.nodeId);
	expect(await readDraft(), "source and index cleanup keep other members' draft bytes and owners").toEqual(before);
	await expect_saved_text(f, "New saved text\n");
});

async function index_run(f: Awaited<ReturnType<typeof create_file>>) {
	const run = await f.t.run(async (ctx) => {
		const state = await ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", f.nodeId))
			.unique();
		return state?.activeRunId ? await ctx.db.get("files_index_runs", state.activeRunId) : null;
	});
	if (!run) throw new Error("Expected an active index run");
	return run;
}

async function index_until(f: Awaited<ReturnType<typeof create_file>>, phase: Doc<"files_index_runs">["phase"]) {
	await f.t.mutation(internal.files_index.start, { nodeId: f.nodeId });
	for (let step = 0; step < 100; step++) {
		const run = await index_run(f);
		if (run.phase === phase) return run;
		const args = { runId: run._id, step: run.step, generation: run.generation };
		if (run.phase === "build_metadata") await f.t.action(internal.files_index.prepare_metadata, args);
		else await f.t.mutation(internal.files_index.advance, args);
	}
	throw new Error(`The index did not reach ${phase}`);
}

test("an old source stays pinned until the new index finishes cleanup", async () => {
	const f = await create_file();
	const args = { membershipId: f.db.membershipId, nodeId: f.nodeId };
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			...args,
			requestId: "pin-first",
			text: "First source\n",
		}),
	).toHaveProperty("_yay");
	await test_finish_file_index(f.t, f.nodeId);
	const headId = await f.t.run(async (ctx) => (await ctx.db.get("files_nodes", f.nodeId))!.contentHeadId!);
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			...args,
			requestId: "pin-second",
			text: "Second source\n",
		}),
	).toHaveProperty("_yay");
	const publishing = await index_until(f, "publish");
	await f.t.mutation(internal.files_content_saves.retire, { headId });
	expect(
		await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", headId)),
		"the published old source is still pinned before the flip",
	).toMatchObject({ retired: false });
	await f.t.mutation(internal.files_index.advance, {
		runId: publishing._id,
		step: publishing.step,
		generation: publishing.generation,
	});
	await f.t.mutation(internal.files_content_saves.retire, { headId });
	expect(
		await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", headId)),
		"the cleanup run keeps its old source pinned after the flip",
	).toMatchObject({ retired: false });
	await test_finish_file_index(f.t, f.nodeId);
	await f.t.mutation(internal.files_content_saves.retire, { headId });
	expect(
		await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", headId)),
		"the old source can retire only after cleanup releases it",
	).toMatchObject({ retired: true });
	await expect_saved_text(f, "Second source\n");
});

test("a busy file publishes its captured source before catching up to the latest Save", async () => {
	const f = await create_file();
	const args = { membershipId: f.db.membershipId, nodeId: f.nodeId };
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			...args,
			requestId: "captured-a",
			text: "---\ntopic: first\n---\nFirst saved text\n",
		}),
	).toHaveProperty("_yay");
	const firstRun = await index_until(f, "build_metadata");
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			...args,
			requestId: "captured-b",
			text: "---\ntopic: second\n---\nSecond saved text\n",
		}),
	).toHaveProperty("_yay");
	const publishing = await index_until(f, "publish");
	expect(publishing._id, "a newer Save does not restart the active build").toBe(firstRun._id);
	expect(publishing.contentHeadId).toBe(firstRun.contentHeadId);
	await f.t.mutation(internal.files_index.advance, {
		runId: publishing._id,
		step: publishing.step,
		generation: publishing.generation,
	});
	const published = await f.t.run((ctx) =>
		ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", f.nodeId))
			.unique(),
	);
	expect(published?.publishedRevision, "the captured revision makes progress under continuous Saves").toBe(
		firstRun.indexRevision,
	);
	expect(published?.requestedRevision).toBeGreaterThan(firstRun.indexRevision);
	const metadataArgs = { ...f.u, subject: { kind: "user" as const, userId: f.u.userId, plugin: null }, path: f.path };
	expect(await f.t.query(internal.files_metadata.get_index_values_by_path, metadataArgs)).toMatchObject({
		values: [{ fieldPath: "frontmatter.topic", stringValue: "first" }],
	});
	await expect_saved_text(f, "---\ntopic: second\n---\nSecond saved text\n");
	await test_finish_file_index(f.t, f.nodeId);
	expect(await f.t.query(internal.files_metadata.get_index_values_by_path, metadataArgs)).toMatchObject({
		values: [{ fieldPath: "frontmatter.topic", stringValue: "second" }],
	});
});

test("old index callbacks cannot write after a step or recovery generation changes", async () => {
	const f = await create_file();
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			requestId: "fenced-index",
			text: "---\ntopic: current\n---\nBody\n",
		}),
	).toHaveProperty("_yay");
	await f.t.mutation(internal.files_index.start, { nodeId: f.nodeId });
	const firstRun = await index_run(f);
	const oldStep = { runId: firstRun._id, step: firstRun.step, generation: firstRun.generation };
	await f.t.mutation(internal.files_index.advance, oldStep);
	const read = () =>
		f.t.run(async (ctx) => ({
			run: await ctx.db.get("files_index_runs", firstRun._id),
			candidates: await ctx.db
				.query("files_index_candidates")
				.withIndex("by_run", (q) => q.eq("runId", firstRun._id))
				.collect(),
		}));
	const afterStep = await read();
	await f.t.mutation(internal.files_index.advance, oldStep);
	expect(await read(), "a duplicate step does not repeat candidate writes").toEqual(afterStep);
	const beforeRecovery = await index_until(f, "build_metadata");
	if (!beforeRecovery.scheduledId) throw new Error("Expected scheduled metadata work");
	await f.t.run((ctx) => ctx.scheduler.cancel(beforeRecovery.scheduledId!));
	await f.t.mutation(internal.files_index.recover_page, {
		phase: "build_metadata",
		cutoff: beforeRecovery.nextAttemptAt + 1,
		cursor: null,
	});
	const recovered = await read();
	expect(recovered.run?.generation).toBe(beforeRecovery.generation + 1);
	await f.t.action(internal.files_index.prepare_metadata, {
		runId: beforeRecovery._id,
		step: beforeRecovery.step,
		generation: beforeRecovery.generation,
	});
	expect(await read(), "an old metadata action cannot write after recovery").toEqual(recovered);
	await test_finish_file_index(f.t, f.nodeId);
});

test("ready index jobs share the workspace in their ready order", async () => {
	const f = await create_file();
	const secondNodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/second.md",
		textContent: "Second original\n",
	});
	expect(
		await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: f.db.membershipId,
			nodeId: secondNodeId,
			acknowledgeDropCollaborativeHistory: true,
		}),
	).toHaveProperty("_yay");
	const second = { ...f, nodeId: secondNodeId, path: "/second.md" };
	for (const file of [f, second])
		expect(
			await file.asU.action(api.files_nodes_content.replace_file_content, {
				membershipId: file.db.membershipId,
				nodeId: file.nodeId,
				requestId: `fair:${file.nodeId}`,
				text: "Saved text\n",
			}),
		).toHaveProperty("_yay");
	const firstReady = await index_until(f, "ready");
	const secondReady = await index_until(second, "ready");
	await f.t.mutation(internal.files_index.advance, {
		runId: secondReady._id,
		step: secondReady.step,
		generation: secondReady.generation,
	});
	expect((await index_run(second)).phase, "a later ready file cannot jump the queue").toBe("ready");
	await f.t.mutation(internal.files_index.advance, {
		runId: firstReady._id,
		step: firstReady.step,
		generation: firstReady.generation,
	});
	expect((await index_run(f)).phase).toBe("tag_text");
	await test_finish_file_index(f.t, f.nodeId);
	const next = await index_until(second, "tag_text");
	expect(next._id, "the next ready file progresses after the first releases its slot").toBe(secondReady._id);
	await test_finish_file_index(f.t, second.nodeId);
});

test("custom metadata is frozen during a build and catches up after clear and recreate", async () => {
	const f = await create_file();
	const metadataArgs = { membershipId: f.db.membershipId, fileNodeId: f.nodeId };
	expect(
		await f.asU.mutation(api.files_metadata.set_entries, { ...metadataArgs, metadataYaml: "topic: first" }),
	).toHaveProperty("_yay");
	const first = await index_until(f, "build_metadata");
	const captured = await f.t.run((ctx) =>
		ctx.db
			.query("files_index_inputs")
			.withIndex("by_run", (q) => q.eq("runId", first._id))
			.unique(),
	);
	expect(captured?.entries).toEqual([{ key: "topic", value: "first" }]);
	expect(await f.asU.mutation(api.files_metadata.set_entries, { ...metadataArgs, metadataYaml: "" })).toHaveProperty(
		"_yay",
	);
	expect(
		await f.asU.mutation(api.files_metadata.set_entries, { ...metadataArgs, metadataYaml: "topic: second" }),
	).toHaveProperty("_yay");
	const publishing = await index_until(f, "publish");
	await f.t.mutation(internal.files_index.advance, {
		runId: publishing._id,
		step: publishing.step,
		generation: publishing.generation,
	});
	const readArgs = { ...f.u, subject: { kind: "user" as const, userId: f.u.userId, plugin: null }, path: f.path };
	expect(
		await f.t.query(internal.files_metadata.get_index_values_by_path, readArgs),
		"the running build uses its frozen custom map",
	).toMatchObject({
		values: [{ fieldPath: "metadata.topic", stringValue: "first" }],
	});
	await test_finish_file_index(f.t, f.nodeId);
	expect(await f.t.query(internal.files_metadata.get_index_values_by_path, readArgs)).toMatchObject({
		values: [{ fieldPath: "metadata.topic", stringValue: "second" }],
	});
});

test.each([false, true])("a restriction survives index publication and cleanup: after flip %s", async (afterFlip) => {
	const f = await create_file();
	expect(
		await f.asU.action(api.files_nodes_content.replace_file_content, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			requestId: "restricted-index",
			text: "---\ntopic: secret\n---\nPrivate text\n",
		}),
	).toHaveProperty("_yay");
	const publishing = await index_until(f, "publish");
	if (afterFlip)
		await f.t.mutation(internal.files_index.advance, {
			runId: publishing._id,
			step: publishing.step,
			generation: publishing.generation,
		});
	expect(
		await f.asU.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
		}),
	).toHaveProperty("_yay");
	expect(
		(
			await f.asV.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: f.vMember.membershipId,
				nodeId: f.nodeId,
			})
		)._nay,
		"the member loses access as soon as the file is restricted",
	).toBeDefined();
	await test_finish_file_index(f.t, f.nodeId);
	await test_finish_saved_scope_jobs(f.t);
	await test_finish_file_index(f.t, f.nodeId);
	const docs = await f.t.run((ctx) =>
		ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode", (q) =>
				q
					.eq("organizationId", f.u.organizationId)
					.eq("workspaceId", f.u.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", f.nodeId),
			)
			.collect(),
	);
	expect(docs.length).toBeGreaterThan(0);
	expect(
		docs.every((doc) => doc.sourceKind === "committed" && doc.restrictedScopeNodeId === f.nodeId),
		"index cleanup never restores the old open scope",
	).toBe(true);
	expect(
		(
			await f.asV.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: f.vMember.membershipId,
				nodeId: f.nodeId,
			})
		)._nay,
	).toBeDefined();
	await expect_saved_text(f, "---\ntopic: secret\n---\nPrivate text\n");
});

const longestPath = `/${"a".repeat(255)}/${"b".repeat(255)}/${"c".repeat(255)}/${"n".repeat(252)}.md`;

function dense_frontmatter(prefix: string) {
	const value = `${"é".repeat(825)}${"値".repeat(201)}`;
	return `---\n${Array.from(
		{ length: 128 },
		(_, index) =>
			`${`${prefix}_${index}_`.padEnd(148, "k")}: [${[0, 1, 2].map((item) => JSON.stringify(`${item}${value}`)).join(", ")}]`,
	).join("\n")}\n---\nBody.\n`;
}

test(
	"public Save replaces the exact dense 886414-byte file at the maximum path",
	{ tags: ["full-size"], timeout: 300_000 },
	async () => {
		const oldText = dense_frontmatter("old");
		const newText = dense_frontmatter("new");
		expect(files_get_utf8_byte_size(oldText)).toBe(886_414);
		expect(files_get_utf8_byte_size(newText)).toBe(886_414);
		expect(longestPath).toHaveLength(1024);
		const metadata = files_metadata_preflight_frontmatter(oldText);
		if (metadata._nay) throw new Error(metadata._nay.message);
		expect(metadata._yay.metadata.fields).toHaveLength(128);
		expect(metadata._yay.metadata.values).toHaveLength(384);
		const f = await create_file(longestPath, oldText);
		await expect_saved_text(f, oldText);
		const saved = await f.asU
			.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				requestId: "dense-replacement",
				text: newText,
			})
			.catch((error: unknown) => ({ _nay: error }));
		expect(saved._nay, "native dense replacement completes under unchanged limits").toBeUndefined();
		await expect_saved_text(f, newText);
		const indexingError = await test_finish_file_index(f.t, f.nodeId).then(
			() => null,
			(error: unknown) => error,
		);
		expect(indexingError, "dense indexing completes under unchanged limits").toBeNull();
		const metadataDocs = await f.t.run((ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", f.nodeId),
				)
				.collect(),
		);
		expect(metadataDocs, "all 128 fields and 384 values are indexed").toHaveLength(512);
		expect(
			metadataDocs.every((doc) => doc.fieldPath.startsWith("frontmatter.new_")),
			"no old frontmatter remains published",
		).toBe(true);
	},
);

test(
	"public Save replaces the exact high-chunk file at the maximum path",
	{ tags: ["full-size"], timeout: 300_000 },
	async () => {
		const oldText = test_max_chunks_markdown();
		expect(files_get_utf8_byte_size(oldText)).toBe(898_930);
		const chunks = await files_chunk_markdown(oldText);
		if (chunks._nay) throw new Error(chunks._nay.message);
		expect(chunks._yay).toHaveLength(2985);
		expect(longestPath).toHaveLength(1024);
		const f = await create_file(longestPath, oldText);
		await expect_saved_text(f, oldText);
		const saved = await f.asU
			.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				requestId: "high-chunk-replacement",
				text: "Small replacement\n",
			})
			.catch((error: unknown) => ({ _nay: error }));
		expect(saved._nay, "native high-chunk replacement completes under unchanged limits").toBeUndefined();
		await expect_saved_text(f, "Small replacement\n");
		const indexingError = await test_finish_file_index(f.t, f.nodeId).then(
			() => null,
			(error: unknown) => error,
		);
		expect(indexingError, "high-chunk indexing completes under unchanged limits").toBeNull();
		const chunksAfter = await f.t.run((ctx) =>
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", f.nodeId),
				)
				.collect(),
		);
		expect(
			chunksAfter.map((chunk) => chunk.plainTextChunk).join(""),
			"the old high-chunk search docs are replaced",
		).toBe("Small replacement");
	},
);
