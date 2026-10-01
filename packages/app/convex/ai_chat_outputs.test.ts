import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { ai_chat_runs_db_insert_node } from "./ai_chat_runs.ts";
import { quotas_db_delete } from "./quotas.ts";
import { ai_chat_tool_output_keep, ai_chat_tool_output_reserve } from "../server/ai-chat-tool-output.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";
import type { ai_chat_ToolOutputRef } from "../shared/ai-chat-files.ts";

// The bodies of the uploads, keyed by R2 key. The fake R2 serves them back for page reads.
let uploads: Map<string, string>;

beforeEach(() => {
	uploads = new Map();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: `https://r2.test/${encodeURIComponent(key!)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key) => `https://r2.test/${encodeURIComponent(key)}`);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
			if (request.method === "PUT") {
				uploads.set(key, await request.text());
				return new Response(null, { status: 200 });
			}
			const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get("Range") ?? "");
			const bytes = new TextEncoder().encode(uploads.get(key) ?? "");
			return range
				? new Response(bytes.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
				: new Response(bytes, { status: 200 });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "outputs-thread",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const source = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		threadId: thread._yay.threadId,
		membershipId: db.membershipId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	const runId = await begin_run({ t, source, messageId: "request" });
	return { t, db, asUser, source, runId };
}

/**
 * Send one user message the way `/api/chat` does, and return the run it starts.
 */
async function begin_run(args: {
	t: ReturnType<typeof test_convex>;
	source: FunctionArgs<typeof internal.ai_chat.thread_run_begin>["source"];
	messageId: string;
}) {
	const { t, messageId, source } = args;

	const begun = await t.mutation(internal.ai_chat.thread_run_begin, {
		source,
		parentId: null,
		messages: [{ clientGeneratedMessageId: messageId, content: { id: messageId, role: "user", parts: [] } }],
		modeId: "agent",
		modelId: ai_chat_DEFAULT_MODEL_ID,
	});
	if (begun._nay) throw new Error(begun._nay.message);
	return begun._yay.runId;
}

/**
 * End a run the way its action does after the last step.
 */
async function end_run(f: Fixture, runId: Id<"ai_chat_runs">) {
	await f.t.mutation(internal.ai_chat_runs.finish, { runId, generation: 1, outcome: "done", tail: null });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Run the tool side of one Bash call: reserve, then keep `text` inline or store it.
 */
async function keep(f: Fixture, text: string) {
	return await f.t.action(async (ctx) => {
		const reservation = await ai_chat_tool_output_reserve(ctx, {
			source: f.source,
			getRun: () => ({ runId: f.runId, generation: 1 }),
			getModelCallId: () => "model_call_test",
			toolCallId: `call-${Math.random()}`,
			tool: "bash",
		});
		const kept = await ai_chat_tool_output_keep(ctx, {
			reservation,
			source: f.source,
			inlineText: text,
			storedText: text,
			contentType: "text/plain; charset=utf-8",
			sourceBytes: new TextEncoder().encode(text).byteLength,
			cutBy: [],
		});
		await ctx.runMutation(internal.ai_chat_outputs.release_reservation, { objectId: reservation.objectId });
		return kept;
	});
}

/**
 * Save the first reply step of `runId` with one Bash part that points at `ref`.
 */
async function save_reply(
	f: Fixture,
	args: { runId: Id<"ai_chat_runs">; id: string; output: string; ref: ai_chat_ToolOutputRef },
) {
	return await f.t.mutation(internal.ai_chat_runs.step_complete, {
		runId: args.runId,
		generation: 1,
		stepIndex: 0,
		parts: [
			{
				type: "tool-bash",
				toolCallId: `${args.id}-call`,
				state: "output-available",
				input: { command: "seq 1 20000" },
				output: {
					title: "exit 0 · /",
					output: args.output,
					metadata: { command: "seq 1 20000", exitCode: 0, output: args.ref },
				},
			},
		],
		finishReason: "tool-calls",
	});
}

async function read_tables(t: Fixture["t"]) {
	return await t.run(async (ctx) => ({
		objects: await ctx.db.query("ai_chat_output_objects").collect(),
		owners: await ctx.db.query("ai_chat_output_owners").collect(),
		quotas: (await ctx.db.query("quotas").collect()).filter((quota) => quota.quotaName.startsWith("ai_chat_output_")),
		jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
	}));
}

const BIG_TEXT = Array.from({ length: 8000 }, (_, index) => `line ${index + 1}`).join("\n");

describe("reserve", () => {
	test("refuses before the tool runs when the workspace chat storage is full", async () => {
		const f = await fixture();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// The first call seeds the counters. Then fill the workspace byte counter.
		await keep(f, "small");
		await f.t.run(async (ctx) => {
			const quota = (await ctx.db.query("quotas").collect()).find(
				(doc) => doc.quotaName === "ai_chat_output_workspace_bytes",
			)!;
			await ctx.db.patch("quotas", quota._id, { usedCount: quota.maxCount - 1024 });
		});

		const refused = await f.t.mutation(internal.ai_chat_outputs.reserve, {
			source: f.source,
			runId: f.runId,
			opKey: "op-full",
			reservedBytes: 1024 * 1024,
		});

		expect(refused._nay).toMatchObject({ name: "storage_full" });
		expect(warn).toHaveBeenCalledWith("Chat save refused", expect.objectContaining({ reason: "storage_full" }));
		expect((await read_tables(f.t)).objects).toEqual([]);
	});
});

describe("ai_chat_tool_output_keep", () => {
	test("keeps a small output inline and gives the whole reservation back", async () => {
		const f = await fixture();

		const kept = await keep(f, "hello");

		expect(kept).toEqual({ output: "hello", ref: null });
		const read = await read_tables(f.t);
		expect(read.objects).toEqual([]);
		expect(read.quotas.map((quota) => quota.usedCount)).toEqual([0, 0, 0]);
		expect(uploads.size).toBe(0);
	});

	test("stores a big output, commits it with the reply, and serves its pages to the chat creator", async () => {
		const f = await fixture();

		const kept = await keep(f, BIG_TEXT);

		const ref = kept.ref!;
		const bytes = new TextEncoder().encode(BIG_TEXT).byteLength;
		expect(ref).toMatchObject({ storedBytes: bytes, sourceBytes: bytes, cutBy: [] });
		expect(kept.output.startsWith("line 1\nline 2\n")).toBe(true);
		expect(kept.output).toContain(`[Full output stored at /tool-output/${ref.outputId}.txt (${bytes} bytes).`);
		expect(kept.output.endsWith("line 8000")).toBe(true);
		// The hold shrank from the reservation to the real size.
		expect((await read_tables(f.t)).quotas.map((quota) => quota.usedCount).sort()).toEqual([1, bytes, bytes].sort());

		expect(await save_reply(f, { runId: f.runId, id: "reply", output: kept.output, ref })).toEqual({ saved: true });
		const read = await read_tables(f.t);
		expect(read.owners).toMatchObject([{ state: "committed", runId: f.runId }]);

		const page = await f.asUser.action(api.ai_chat_outputs.read_page, {
			membershipId: f.db.membershipId,
			threadId: f.source.threadId,
			outputId: ref.outputId,
			offset: 0,
			limit: 12,
		});
		expect(page).toEqual({ _yay: { text: "line 1\nline ", offset: 0, nextOffset: 12, totalBytes: bytes } });

		// Another member of the workspace gets the same answer as for a missing output.
		const other = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "outputs-other-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asOther = f.t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.action(api.ai_chat_outputs.read_page, {
				membershipId: other.membershipId,
				threadId: f.source.threadId,
				outputId: ref.outputId,
				offset: 0,
				limit: 12,
			}),
		).toEqual({ _nay: { message: "Not found" } });
	});

	test("drops a ref whose owner the run end already removed, and says the full output was not saved", async () => {
		const f = await fixture();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const kept = await keep(f, BIG_TEXT);

		// The run ends before the reply is saved, so its pending owner goes away with it.
		await end_run(f, f.runId);
		const afterEnd = await read_tables(f.t);
		expect(afterEnd.owners).toEqual([]);
		expect(afterEnd.objects).toMatchObject([{ state: { kind: "deleting" }, ownerCount: 0 }]);
		expect(afterEnd.jobs).toMatchObject([{ reason: "chat_output", chatOutputObjectId: kept.ref!.outputId }]);

		// An ended run saves no more steps. A later run that names the old ref keeps only its preview.
		const laterRunId = await begin_run({ t: f.t, source: f.source, messageId: "later-request" });
		expect(await save_reply(f, { runId: laterRunId, id: "late", output: kept.output, ref: kept.ref! })).toEqual({
			saved: true,
		});
		expect(error).toHaveBeenCalledWith(
			"Chat data not saved",
			expect.objectContaining({ reason: "output_ref_dropped", objectId: kept.ref!.outputId }),
		);
		const saved = await f.t.run((ctx) => ctx.db.query("ai_chat_run_steps").collect());
		const part = (saved.at(-1)!.parts as Array<{ output: { output: string; metadata: object } }>)[0]!;
		expect(part.output.output.endsWith("\n[Full output not saved.]")).toBe(true);
		expect(part.output.metadata).not.toHaveProperty("output");

		// The confirmed R2 delete gives the whole hold back.
		const job = afterEnd.jobs[0]!;
		await f.t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: Date.now(),
		});
		const settled = await read_tables(f.t);
		expect(settled.objects).toEqual([]);
		expect(settled.jobs).toEqual([]);
		expect(settled.quotas.map((quota) => quota.usedCount)).toEqual([0, 0, 0]);
	});
});

describe("BashToolOutputFs", () => {
	test("stores a long transcript and a later call reads it through /tool-output", async () => {
		const f = await fixture();
		const names = await f.t.run(async (ctx) => ({
			organizationName: (await ctx.db.get("organizations", f.db.organizationId))!.name,
			workspaceName: (await ctx.db.get("organizations_workspaces", f.db.workspaceId))!.name,
		}));
		let callNumber = 0;
		const run = (command: string) =>
			f.t.action(async (ctx) => {
				const toolCallId = `bash-${callNumber++}`;
				const reservation = await ai_chat_tool_output_reserve(ctx, {
					source: f.source,
					getRun: () => ({ runId: f.runId, generation: 1 }),
					getModelCallId: () => "model_call_test",
					toolCallId,
					tool: "bash",
				});
				return await ctx
					.runAction(internal.bash.run, {
						...f.source,
						...names,
						toolCallId,
						command,
						allowDbFilesMkdir: true,
						shellName: "default",
						wakeAgent: null,
						output: reservation,
						run: { runId: f.runId, generation: 1 },
					})
					.finally(() =>
						ctx.runMutation(internal.ai_chat_outputs.release_reservation, { objectId: reservation.objectId }),
					);
			});

		const long = await run("seq 1 9000; seq 9001 18000");
		const ref = long.metadata.output!;
		expect(long.output).toContain(`[Full output stored at /tool-output/${ref.outputId}.txt`);
		expect(long.output).toContain("\n18000\n");
		expect(new TextEncoder().encode(long.output).byteLength).toBeLessThan(24 * 1024);

		const listed = await run("ls -l /tool-output");
		expect(listed.output).toContain(`${ref.storedBytes}`);
		expect(listed.output).toContain(`${ref.outputId}.txt`);
		// The stored transcript starts with the command line and an empty line.
		const paged = await run(`sed -n '12347,12348p' /tool-output/${ref.outputId}.txt`);
		expect(paged.output).toContain("\n12345\n12346\n");
		const searched = await run(
			`grep -c '^1799' /tool-output/${ref.outputId}.txt; tail -n 1 /tool-output/${ref.outputId}.txt`,
		);
		expect(searched.output).toContain("\n11\n");
		expect(searched.output).toContain("exit 0");
		const written = await run(`echo x > /tool-output/${ref.outputId}.txt`);
		expect(written.output).toContain("EROFS: read-only file system");
	});
});

describe("drain_deleting_thread", () => {
	test("Delete chat removes its outputs and the R2 delete gives the storage back", async () => {
		const f = await fixture();
		const kept = await keep(f, BIG_TEXT);
		await save_reply(f, { runId: f.runId, id: "reply", output: kept.output, ref: kept.ref! });
		await end_run(f, f.runId);

		await f.asUser.mutation(api.ai_chat.thread_delete, {
			membershipId: f.db.membershipId,
			threadId: f.source.threadId,
		});
		let done = false;
		for (let pass = 0; pass < 50 && !done; pass += 1) {
			done = (
				await f.t.mutation(internal.data_deletion.drain_deleting_thread, {
					threadId: f.source.threadId,
					_test_disableReschedule: true,
				})
			).done;
		}
		expect(done).toBe(true);

		const drained = await read_tables(f.t);
		expect(drained.owners).toEqual([]);
		expect(drained.objects).toMatchObject([{ state: { kind: "deleting" } }]);
		const job = drained.jobs[0]!;
		await f.t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: Date.now(),
		});
		const settled = await read_tables(f.t);
		expect(settled.objects).toEqual([]);
		expect(settled.quotas.map((quota) => quota.usedCount)).toEqual([0, 0, 0]);
	});
});

describe("ai_chat_outputs_db_copy_owners", () => {
	test("a branch copy keeps the output readable after the source is deleted, and the last owner frees it", async () => {
		const f = await fixture();
		const kept = await keep(f, BIG_TEXT);
		await save_reply(f, { runId: f.runId, id: "reply", output: kept.output, ref: kept.ref! });
		await end_run(f, f.runId);

		const branched = await f.asUser.action(api.ai_chat.thread_branch, {
			membershipId: f.db.membershipId,
			threadId: f.source.threadId,
		});
		const branchThreadId = branched._yay!.threadId;
		expect((await read_tables(f.t)).objects).toMatchObject([{ ownerCount: 2 }]);

		// Delete chat marks the chat and drains it. The rate limiter allows only two thread writes at
		// once, so mark it here instead of calling `thread_delete`.
		const deleteChat = async (threadId: Id<"ai_chat_threads">) => {
			await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { deletingAt: Date.now() }));
			let done = false;
			for (let pass = 0; pass < 50 && !done; pass += 1) {
				done = (
					await f.t.mutation(internal.data_deletion.drain_deleting_thread, {
						threadId,
						_test_disableReschedule: true,
					})
				).done;
			}
			expect(done).toBe(true);
		};
		await deleteChat(f.source.threadId);

		expect((await read_tables(f.t)).objects).toMatchObject([{ ownerCount: 1, state: { kind: "ready" } }]);
		const page = await f.asUser.action(api.ai_chat_outputs.read_page, {
			membershipId: f.db.membershipId,
			threadId: branchThreadId,
			outputId: kept.ref!.outputId,
			offset: 0,
			limit: 12,
		});
		expect(page._yay?.text).toBe("line 1\nline ");

		await deleteChat(branchThreadId);
		expect((await read_tables(f.t)).objects).toMatchObject([{ ownerCount: 0, state: { kind: "deleting" } }]);
	});

	test("a ref pasted from another chat grants the copy nothing", async () => {
		const f = await fixture();
		const kept = await keep(f, BIG_TEXT);
		await save_reply(f, { runId: f.runId, id: "reply", output: kept.output, ref: kept.ref! });
		await end_run(f, f.runId);
		// A second chat whose message names the first chat's output. It has no owner doc for it.
		const otherThreadId = await f.t.run(async (ctx) => {
			const source = (await ctx.db.get("ai_chat_threads", f.source.threadId))!;
			const { _id, _creationTime, ...fields } = source;
			const threadId = await ctx.db.insert("ai_chat_threads", { ...fields, outputOwnerCount: 0, newestNodeId: null });
			const step = (await ctx.db.query("ai_chat_run_steps").first())!;
			await ai_chat_runs_db_insert_node(ctx, {
				thread: (await ctx.db.get("ai_chat_threads", threadId))!,
				parentId: null,
				createdBy: f.db.userId,
				clientGeneratedMessageId: "pasted",
				content: { id: "pasted", role: "assistant", parts: step.parts },
				status: "done",
				runId: null,
				wakePending: false,
				jobFinishInvocationId: null,
				newest: "set",
				now: Date.now(),
			});
			return threadId;
		});

		const branched = await f.asUser.action(api.ai_chat.thread_branch, {
			membershipId: f.db.membershipId,
			threadId: otherThreadId,
		});

		const read = await read_tables(f.t);
		expect(read.owners.map((owner) => owner.threadId)).toEqual([f.source.threadId]);
		expect(read.objects).toMatchObject([{ ownerCount: 1 }]);
		const page = await f.asUser.action(api.ai_chat_outputs.read_page, {
			membershipId: f.db.membershipId,
			threadId: branched._yay!.threadId,
			outputId: kept.ref!.outputId,
			offset: 0,
			limit: 12,
		});
		expect(page).toEqual({ _nay: { message: "Not found" } });
	});
});

describe("quotas_db_delete", () => {
	test("retires the counters while an output still holds them, and the last settle deletes them", async () => {
		const f = await fixture();
		const kept = await keep(f, BIG_TEXT);
		await end_run(f, f.runId);
		const job = (await read_tables(f.t)).jobs[0]!;
		expect(job.chatOutputObjectId).toBe(kept.ref!.outputId);

		// Account or workspace deletion reaches the counters before R2 confirms the delete.
		await f.t.run(async (ctx) => {
			for (const quota of (await ctx.db.query("quotas").collect()).filter((doc) =>
				doc.quotaName.startsWith("ai_chat_output_"),
			)) {
				await quotas_db_delete(ctx, quota);
			}
		});
		const retired = (await read_tables(f.t)).quotas;
		expect(retired).toHaveLength(3);
		expect(retired.every((quota) => quota.retiredAt !== undefined)).toBe(true);

		await f.t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: Date.now(),
		});
		const settled = await read_tables(f.t);
		expect(settled.objects).toEqual([]);
		expect(settled.quotas).toEqual([]);
	});
});

describe("fail_expired_uploads", () => {
	test("deletes an upload whose action died before attach, after its PUT deadline", async () => {
		const f = await fixture();
		const reserved = await f.t.mutation(internal.ai_chat_outputs.reserve, {
			source: f.source,
			runId: f.runId,
			opKey: "op-dead",
			reservedBytes: 1024,
		});
		const objectId = reserved._yay!;
		const begun = await f.t.mutation(internal.ai_chat_outputs.begin_upload, {
			objectId,
			runId: f.runId,
			byteCount: 100,
			sha256: "0".repeat(64),
			contentType: "text/plain; charset=utf-8",
			attemptId: "attempt-dead",
			putMayArriveUntil: 1_000,
		});
		expect(begun._yay).toBeDefined();

		await f.t.mutation(internal.ai_chat_outputs.fail_expired_uploads, { _test_now: 999 });
		expect((await read_tables(f.t)).objects).toMatchObject([{ state: { kind: "uploading" } }]);

		await f.t.mutation(internal.ai_chat_outputs.fail_expired_uploads, { _test_now: 1_000 });
		const read = await read_tables(f.t);
		expect(read.objects).toMatchObject([{ state: { kind: "deleting" } }]);
		expect(read.jobs).toMatchObject([{ chatOutputObjectId: objectId, putMayArriveUntil: 1_000 }]);
	});
});
