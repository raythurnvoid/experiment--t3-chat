/// <reference types="vite/client" />
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal, api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_ingestion_db_finalize_file } from "./files_ingestion.ts";
import { files_upload_content_from_bytes } from "../server/files-upload-content.ts";
import { files_yjs_create_empty_state_update } from "../shared/files-yjs.ts";
import { files_u8_to_array_buffer } from "../shared/files.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_files_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key) => `https://r2.test/${key}`);
});

afterEach(() => vi.restoreAllMocks());

const output = {
	requestId: "output-1",
	attemptId: "attempt-1",
	path: "/output.bin",
	size: 4,
	contentType: "application/octet-stream",
	digest: "a".repeat(64),
	content: { kind: "stored" as const },
};

async function seed_scope(t: ReturnType<typeof test_convex>) {
	return t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
}

async function prepare_stored(
	t: ReturnType<typeof test_convex>,
	scope: Awaited<ReturnType<typeof seed_scope>>,
	changes: Partial<typeof output> = {},
) {
	const result = await t.mutation(internal.files_ingestion.prepare_file, { ...scope, ...output, ...changes });
	if (result._nay) throw new Error(result._nay.message);
	if (result._yay.kind !== "stored") throw new Error("Expected a stored preparation");
	return result._yay;
}

async function prepare_text(
	t: ReturnType<typeof test_convex>,
	scope: Awaited<ReturnType<typeof seed_scope>>,
	path = "/notes.txt",
) {
	const result = await t.mutation(internal.files_ingestion.prepare_file, {
		...scope,
		...output,
		path,
		size: 5,
		contentType: "text/plain;charset=utf-8",
		content: { kind: "text", textKind: "plain_text" },
	});
	if (result._nay) throw new Error(result._nay.message);
	if (result._yay.kind !== "text") throw new Error("Expected a text preparation");
	return result._yay;
}

async function stage_text(
	t: ReturnType<typeof test_convex>,
	scope: Awaited<ReturnType<typeof seed_scope>>,
	prepared: Awaited<ReturnType<typeof prepare_text>>,
) {
	const content = files_upload_content_from_bytes({
		bytes: new TextEncoder().encode("hello"),
		contentType: "text/plain",
	});
	if (content.kind !== "text") throw new Error("Expected editable text");
	const empty = files_u8_to_array_buffer(files_yjs_create_empty_state_update());
	const sealed = [];
	for (const role of ["base", "staged", "unstaged"] as const) {
		const bytes = role === "unstaged" ? content.snapshotUpdate : empty;
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			operationBatchId: prepared.operationBatchId,
			phase: "output",
			role,
			pageIndex: 0,
			bytes,
		});
		if (staged._nay) throw new Error(staged._nay.message);
		const result = await t.mutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			operationBatchId: prepared.operationBatchId,
			phase: "output",
			role,
			expectedTotalBytes: bytes.byteLength,
		});
		if (result._nay) throw new Error(result._nay.message);
		sealed.push(result._yay);
	}
	return {
		family: {
			operationBatchId: prepared.operationBatchId,
			baseStateId: sealed[0]!.stateId,
			baseStateDigest: sealed[0]!.digest,
			stagedStateId: sealed[1]!.stateId,
			stagedStateDigest: sealed[1]!.digest,
			unstagedStateId: sealed[2]!.stateId,
			unstagedStateDigest: sealed[2]!.digest,
		},
		unstagedText: "hello",
	};
}

describe("prepare_file", () => {
	test("replays a lost prepare reply without another asset or hold", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const first = await prepare_stored(t, scope);
		expect(await prepare_stored(t, scope)).toEqual(first);
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(0);
	});

	test("keeps a concurrent attempt out of the prepared resources", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_stored(t, scope);
		const rival = await t.mutation(internal.files_ingestion.prepare_file, { ...scope, ...output, attemptId: "other" });
		expect(rival._nay?.message).toContain("in progress");
		await t.mutation(internal.files_ingestion.abort_file, {
			userId: scope.userId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			receiptId: prepared.receiptId,
			attemptId: "other",
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", prepared.assetId))).not.toBeNull();
		expect(
			(
				await t.mutation(internal.files_ingestion.finalize_file, {
					...scope,
					receiptId: prepared.receiptId,
					attemptId: "other",
				})
			)._nay,
		).toBeDefined();
	});

	test.each(["digest", "path", "contentType", "size"] as const)(
		"refuses changed %s on the same request",
		async (field) => {
			const t = test_convex();
			const scope = await seed_scope(t);
			await prepare_stored(t, scope);
			const changes = { digest: "b".repeat(64), path: "/other.bin", contentType: "application/zip", size: 5 };
			const result = await t.mutation(internal.files_ingestion.prepare_file, {
				...scope,
				...output,
				[field]: changes[field],
			});
			expect(result._nay?.message).toContain("different content");
			expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toHaveLength(1);
		},
	);

	test.each(["output", "/", "/../out", "/a/../out", "/a//out", "/a/./out", "/a\\out", "/a/*", "/a/out "])(
		"rejects %j before allocation",
		async (path) => {
			const t = test_convex();
			const scope = await seed_scope(t);
			expect(
				(await t.mutation(internal.files_ingestion.prepare_file, { ...scope, ...output, path }))._nay,
			).toBeDefined();
			expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toEqual([]);
		},
	);

	test("checks depth and node quota before reserving an asset", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const deep = `/${Array.from({ length: 33 }, (_, i) => `a${i}`).join("/")}`;
		expect(
			(await t.mutation(internal.files_ingestion.prepare_file, { ...scope, ...output, path: deep }))._nay,
		).toBeDefined();
		await t.run(async (ctx) => {
			const id = await quotas_db_ensure(ctx, { ...scope, quotaName: "files_private_nodes", now: Date.now() });
			await ctx.db.patch("quotas", id, { maxCount: 0 });
		});
		expect((await t.mutation(internal.files_ingestion.prepare_file, { ...scope, ...output }))._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("keeps the declared text shape and hides unfinished text", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_text(t, scope, "/notes.md");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", prepared.pendingUpdateId));
		expect(proposal?.createIntent).toMatchObject({
			kind: "text",
			textKind: "plain_text",
			contentType: "text/plain;charset=utf-8",
		});
		expect(proposal?.content).toBeUndefined();
		expect(
			await t.mutation(internal.files_ingestion.prepare_file, {
				...scope,
				...output,
				path: "/notes.md",
				size: 5,
				contentType: "text/plain;charset=utf-8",
				content: { kind: "text", textKind: "plain_text" },
			}),
		).toMatchObject({ _yay: prepared });
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: scope.membershipId,
			target: prepared.target,
			pendingUpdateId: prepared.pendingUpdateId,
			reviewedRevision: 1,
		});
		expect(saved._nay).toBeDefined();
	});
});

describe("finalize_file", () => {
	test("replays a completed file after Save and keeps it after receipt expiry", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_stored(t, scope);
		const args = { ...scope, receiptId: prepared.receiptId, attemptId: output.attemptId };
		const completed = await t.mutation(internal.files_ingestion.finalize_file, args);
		if (!completed._yay) throw new Error("Expected a completed file");
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target: completed._yay.target,
		});
		if (!view?.entry.pendingUpdate) throw new Error("Expected a proposal");
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: scope.membershipId,
			target: completed._yay.target,
			pendingUpdateId: view.entry.pendingUpdate._id,
			reviewedRevision: view.entry.pendingUpdate.revision,
		});
		if (!saved._yay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved file");
		const savedTarget = saved._yay.target;
		expect((await t.mutation(internal.files_ingestion.finalize_file, args))._yay).toEqual({
			...completed._yay,
			target: saved._yay.target,
		});
		await t.run((ctx) => ctx.db.patch("files_ingestion_receipts", prepared.receiptId, { expiresAt: 0 }));
		await t.mutation(internal.files_ingestion.cleanup_expired_receipts, {});
		expect(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", prepared.receiptId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", savedTarget.id))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", prepared.assetId))).not.toBeNull();
	});

	test("creates each file once and gives collisions their own names", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const first = await prepare_stored(t, scope);
		const args = { ...scope, receiptId: first.receiptId, attemptId: output.attemptId };
		const result = await t.mutation(internal.files_ingestion.finalize_file, args);
		expect(result._yay?.path).toBe("/output.bin");
		const closedProducer = vi.fn(async () => ({ _nay: { message: "Producer closed" } }));
		expect(
			await t.run((ctx) => files_ingestion_db_finalize_file(ctx, { ...args, attemptId: "retry" }, closedProducer)),
		).toEqual(result);
		expect(closedProducer).not.toHaveBeenCalled();
		const second = await prepare_stored(t, scope, { requestId: "output-2", size: 0 });
		expect(
			(
				await t.mutation(internal.files_ingestion.finalize_file, {
					...scope,
					receiptId: second.receiptId,
					attemptId: output.attemptId,
				})
			)._yay?.path,
		).toBe("/output-2.bin");
	});

	test("commits text readiness and receipt together", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_text(t, scope);
		const text = await stage_text(t, scope, prepared);
		const result = await t.mutation(internal.files_ingestion.finalize_file, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: output.attemptId,
			text,
		});
		expect(result._yay).toMatchObject({
			target: prepared.target,
			path: "/notes.txt",
			size: 5,
			contentType: "text/plain;charset=utf-8",
		});
		expect((await t.run((ctx) => ctx.db.get("files_ingestion_receipts", prepared.receiptId)))?.state.kind).toBe(
			"completed",
		);
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_updates", prepared.pendingUpdateId)))?.content?.base,
		).toEqual({ kind: "new" });
		expect(
			await t.mutation(internal.files_ingestion.finalize_file, {
				...scope,
				receiptId: prepared.receiptId,
				attemptId: "retry",
			}),
		).toEqual(result);
	});

	test("refuses a new file when access changes during upload", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_stored(t, scope);
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", scope.membershipId, { active: false }));
		expect(
			(
				await t.mutation(internal.files_ingestion.finalize_file, {
					...scope,
					receiptId: prepared.receiptId,
					attemptId: output.attemptId,
				})
			)._nay,
		).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
	});
});

describe("abort_file", () => {
	test("keeps completed files and late-PUT holds", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const completed = await prepare_stored(t, scope);
		await t.mutation(internal.files_ingestion.finalize_file, {
			...scope,
			receiptId: completed.receiptId,
			attemptId: output.attemptId,
		});
		const unfinished = await prepare_stored(t, scope, { requestId: "output-2" });
		for (const receiptId of [completed.receiptId, unfinished.receiptId])
			await t.mutation(internal.files_ingestion.abort_file, {
				userId: scope.userId,
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				receiptId,
				attemptId: output.attemptId,
			});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", completed.assetId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", unfinished.assetId))).toBeNull();
		const holds = await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(holds.find((hold) => hold.resource.id === unfinished.assetId)?.settlement.kind).toBe("held");
		const deletion = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(deletion).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ r2Key: unfinished.r2Key, putMayArriveUntil: expect.any(Number) }),
			]),
		);
		expect(
			(await t.mutation(internal.files_ingestion.prepare_file, { ...scope, ...output, requestId: "output-2" }))._nay
				?.message,
		).toContain("aborted");
	});

	test("retires unfinished text but keeps a reused parent", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_text(t, scope, "/reports/notes.txt");
		const sibling = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			path: "/reports/kept.txt",
			kind: "file",
		});
		expect(sibling._yay).toBeDefined();
		await t.mutation(internal.files_ingestion.abort_file, {
			userId: scope.userId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			receiptId: prepared.receiptId,
			attemptId: output.attemptId,
		});
		const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.find((node) => node.name === "reports")?.state).toBe("active");
		expect(nodes.find((node) => node.name === "notes.txt")?.state).toBe("discarded");
		expect(nodes.find((node) => node.name === "kept.txt")?.state).toBe("active");
	});
});

describe("cleanup_expired_receipts", () => {
	test("aborts expired preparation and later drops only the receipt", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const prepared = await prepare_stored(t, scope);
		await t.run((ctx) => ctx.db.patch("files_ingestion_receipts", prepared.receiptId, { expiresAt: 0 }));
		await t.mutation(internal.files_ingestion.cleanup_expired_receipts, {});
		expect((await t.run((ctx) => ctx.db.get("files_ingestion_receipts", prepared.receiptId)))?.state.kind).toBe(
			"aborted",
		);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", prepared.assetId))).toBeNull();
		await t.run((ctx) => ctx.db.patch("files_ingestion_receipts", prepared.receiptId, { expiresAt: 0 }));
		await t.mutation(internal.files_ingestion.cleanup_expired_receipts, {});
		expect(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", prepared.receiptId))).toBeNull();
	});
});

// The chat doors are tested here, not in `ai_chat_files.test.ts`, because every case needs the
// receipt fixtures above. `ai_chat_files.test.ts` would have to copy all of `seed_scope`,
// `prepare_stored` and `stage_text` to reach the same state.
describe("chat file output", () => {
	async function create_thread(t: ReturnType<typeof test_convex>, scope: Awaited<ReturnType<typeof seed_scope>>) {
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: scope.membershipId,
			clientGeneratedId: "ingestion-thread",
			title: "Output",
			lastMessageAt: Date.now(),
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.threadId;
	}

	test("refuses Ask mode before allocating resources", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const threadId = await create_thread(t, scope);
		const result = await t.mutation(internal.ai_chat_files.prepare_file_output, {
			...scope,
			...output,
			threadId,
			modeId: "ask",
		});
		expect(result._nay?.message).toContain("Agent mode");
		expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("refuses a thread in another workspace", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);
		const threadId = await create_thread(t, other);
		expect(
			(await t.mutation(internal.ai_chat_files.prepare_file_output, { ...scope, ...output, threadId, modeId: "agent" }))
				._nay,
		).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("checks the thread again at commit and keeps completed retries readable", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const threadId = await create_thread(t, scope);
		const args = { ...scope, ...output, threadId, modeId: "agent" as const };
		const first = await t.mutation(internal.ai_chat_files.prepare_file_output, args);
		if (!first._yay || first._yay.kind !== "stored") throw new Error("Expected a stored preparation");
		const finalArgs = {
			...scope,
			threadId,
			modeId: "agent" as const,
			receiptId: first._yay.receiptId,
			attemptId: output.attemptId,
		};
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { archived: true }));
		expect((await t.mutation(internal.ai_chat_files.finalize_file_output, finalArgs))._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { archived: false }));
		const completed = await t.mutation(internal.ai_chat_files.finalize_file_output, finalArgs);
		expect(completed._yay?.path).toBe(output.path);
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { archived: true }));
		expect(
			await t.mutation(internal.ai_chat_files.finalize_file_output, {
				...finalArgs,
				modeId: "ask",
				attemptId: "lost-reply",
			}),
		).toEqual(completed);
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", scope.membershipId, { active: false }));
		expect((await t.mutation(internal.ai_chat_files.finalize_file_output, finalArgs))._nay).toBeDefined();
	});
});

describe("ingestion purge", () => {
	test("workspace purge retires uploads and leaves another workspace alone", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);
		const pending = await prepare_stored(t, scope);
		const control = await prepare_stored(t, other);
		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: scope.userId,
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);
		for (let pass = 0; pass < 20; pass++) {
			await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId });
			if (!(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", pending.receiptId)))) break;
		}
		expect(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", pending.receiptId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", pending.assetId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", control.receiptId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", control.assetId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ r2Key: pending.r2Key, putMayArriveUntil: expect.any(Number) }),
			]),
		);
	});

	test("user purge closes unfinished text before its batch is removed", async () => {
		const t = test_convex();
		const scope = await seed_scope(t);
		const pending = await prepare_text(t, scope);
		await stage_text(t, scope, pending);
		for (let pass = 0; pass < 20; pass++) {
			await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: scope.userId,
				deleteUserRecord: false,
				_test_disableReschedule: true,
			});
			if (!(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", pending.receiptId)))) break;
		}
		expect(await t.run((ctx) => ctx.db.get("files_ingestion_receipts", pending.receiptId))).toBeNull();
		if (pending.target.kind !== "private") throw new Error("Expected private text");
		expect((await t.run((ctx) => ctx.db.get("files_pending_nodes", pending.target.id)))?.state).toBe("discarded");
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", pending.operationBatchId)))?.expiresAt,
		).toBeLessThanOrEqual(Date.now());
	});
});
