import { R2 } from "@convex-dev/r2";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Result } from "common/errors-as-values-utils.ts";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { files_ingestion_decode_base64, files_ingestion_write } from "./files-ingestion.ts";

const scope = {
	userId: "user-1" as Id<"users">,
	membershipId: "membership-1" as Id<"organizations_workspaces_users">,
	organizationId: "organization-1" as Id<"organizations">,
	workspaceId: "workspace-1" as Id<"organizations_workspaces">,
	threadId: "thread-1" as Id<"ai_chat_threads">,
};
const binary = { path: "/reports/binary", bytes: new Uint8Array([0, 255, 128, 1]) };
const prepared = {
	kind: "stored" as const,
	receiptId: "receipt-1" as Id<"files_ingestion_receipts">,
	assetId: "asset-1" as Id<"files_r2_assets">,
	r2Key: "file-1",
};
const file = {
	target: { kind: "private" as const, id: "private-1" as Id<"files_pending_nodes"> },
	path: binary.path,
	contentType: "application/octet-stream",
	size: 4,
};

function makeWriter() {
	const runMutation = vi.fn().mockResolvedValue(null);
	const runQuery = vi.fn();
	const ctx = { runMutation, runQuery } as unknown as ActionCtx;
	const producer = {
		requestId: "tool-1",
		prepare: vi.fn<Parameters<typeof files_ingestion_write>[3]["prepare"]>().mockResolvedValue({ _yay: prepared }),
		finalize: vi.fn<Parameters<typeof files_ingestion_write>[3]["finalize"]>().mockResolvedValue({ _yay: file }),
	};
	return { ctx, producer, runMutation, runQuery };
}

describe("files_ingestion_write", () => {
	beforeEach(() => {
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
			key,
			url: `https://r2.test/${key}`,
		}));
		vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => new Response(null)),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test("binds exact bytes, MIME, digest, and retry identity before PUT", async () => {
		const { ctx, producer } = makeWriter();
		const syncMetadata = vi.spyOn(R2.prototype, "syncMetadata");
		expect(await files_ingestion_write(ctx, scope, [binary], producer)).toEqual([{ status: "succeeded", file }]);
		expect(producer.prepare.mock.calls[0]?.[0]).toMatchObject({
			...scope,
			path: binary.path,
			contentType: file.contentType,
			size: 4,
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
			requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
			content: { kind: "stored" },
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://r2.test/file-1",
			expect.objectContaining({
				method: "PUT",
				body: binary.bytes,
				headers: { "Content-Type": file.contentType },
				signal: expect.any(AbortSignal),
			}),
		);
		expect(producer.finalize.mock.calls[0]?.[0]).toMatchObject({
			receiptId: prepared.receiptId,
			attemptId: producer.prepare.mock.calls[0]?.[0].attemptId,
		});
		expect(syncMetadata).toHaveBeenCalledOnce();
	});

	test("stores an empty custom binary", async () => {
		const { ctx, producer } = makeWriter();
		await files_ingestion_write(
			ctx,
			scope,
			[{ path: "/empty", contentType: "application/x-custom", bytes: new Uint8Array(0) }],
			producer,
		);
		expect(producer.prepare.mock.calls[0]?.[0]).toMatchObject({
			size: 0,
			contentType: "application/x-custom",
			content: { kind: "stored" },
		});
		expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: new Uint8Array(0) }));
	});

	test.each(["prepare", "finalize"] as const)("retries a lost %s reply with identical arguments", async (method) => {
		const { ctx, producer } = makeWriter();
		producer[method].mockRejectedValueOnce(new Error("Lost reply"));
		expect((await files_ingestion_write(ctx, scope, [binary], producer))[0]?.status).toBe("succeeded");
		expect(producer[method].mock.calls[0]).toEqual(producer[method].mock.calls[1]);
		expect(fetch).toHaveBeenCalledOnce();
	});

	test("returns a completed retry without another upload or finalize", async () => {
		const { ctx, producer } = makeWriter();
		producer.prepare.mockResolvedValue({ _yay: { kind: "completed", file } });
		expect(await files_ingestion_write(ctx, scope, [binary], producer)).toEqual([{ status: "succeeded", file }]);
		expect(fetch).not.toHaveBeenCalled();
		expect(producer.finalize).not.toHaveBeenCalled();
	});

	test("keeps successful siblings after one finalization fails", async () => {
		const { ctx, producer, runMutation } = makeWriter();
		producer.finalize
			.mockResolvedValueOnce({ _yay: file })
			.mockResolvedValueOnce(Result({ _nay: { message: "Quota changed" } }));
		const results = await files_ingestion_write(
			ctx,
			scope,
			[binary, { ...binary, path: "/reports/second" }, { ...binary, path: "/reports/third" }],
			producer,
		);
		expect(results.map((item) => item.status)).toEqual(["succeeded", "errored", "succeeded"]);
		expect(producer.prepare.mock.calls[0]?.[0].requestId).not.toBe(producer.prepare.mock.calls[1]?.[0].requestId);
		expect(runMutation).toHaveBeenCalledOnce();
		expect(getFunctionName(runMutation.mock.calls[0]?.[0] as FunctionReference<"mutation">)).toBe(
			"files_ingestion:abort_file",
		);
		expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
			receiptId: prepared.receiptId,
			attemptId: producer.prepare.mock.calls[1]?.[0].attemptId,
		});
	});

	test("does not PUT or abort when prepare refuses", async () => {
		const { ctx, producer, runMutation } = makeWriter();
		producer.prepare.mockResolvedValue(Result({ _nay: { message: "Denied" } }));
		expect(await files_ingestion_write(ctx, scope, [binary], producer)).toEqual([{ status: "errored", index: 0 }]);
		expect(producer.prepare).toHaveBeenCalledOnce();
		expect(runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("Stop before prepare makes no changes", async () => {
		const { ctx, producer, runMutation } = makeWriter();
		const controller = new AbortController();
		controller.abort();
		expect(await files_ingestion_write(ctx, scope, [binary], producer, controller.signal)).toEqual([
			{ status: "cancelled", index: 0 },
		]);
		expect(producer.prepare).not.toHaveBeenCalled();
		expect(runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("Stop during prepare retires only that attempt", async () => {
		const { ctx, producer, runMutation } = makeWriter();
		const controller = new AbortController();
		producer.prepare.mockImplementation(async () => {
			controller.abort();
			return { _yay: prepared };
		});
		expect(await files_ingestion_write(ctx, scope, [binary], producer, controller.signal)).toEqual([
			{ status: "cancelled", index: 0 },
		]);
		expect(fetch).not.toHaveBeenCalled();
		expect(runMutation).toHaveBeenCalledOnce();
		expect(producer.finalize).not.toHaveBeenCalled();
	});

	test("Stop aborts the PUT signal and keeps earlier completed files", async () => {
		const { ctx, producer, runMutation } = makeWriter();
		const controller = new AbortController();
		vi.mocked(fetch)
			.mockImplementationOnce(async () => new Response(null))
			.mockImplementationOnce(async (_url, init) => {
				controller.abort();
				expect(init?.signal?.aborted).toBe(true);
				throw new DOMException("Stopped", "AbortError");
			});
		const results = await files_ingestion_write(ctx, scope, [binary, binary, binary], producer, controller.signal);
		expect(results.map((item) => item.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
		expect(producer.finalize).toHaveBeenCalledOnce();
		expect(runMutation).toHaveBeenCalledOnce();
	});

	test.each([
		"../escape",
		"/../escape",
		"/folder/../escape",
		"/folder//file",
		"/folder/file ",
		"/folder/*.bin",
		"/",
		"/UPPER/file",
	])("refuses noncanonical path %s before preparing any item", async (path) => {
		const { ctx, producer } = makeWriter();
		await expect(files_ingestion_write(ctx, scope, [binary, { ...binary, path }], producer)).rejects.toThrow();
		expect(producer.prepare).not.toHaveBeenCalled();
	});

	test.each([
		{ files: Array.from({ length: 9 }, () => binary) },
		{ files: [{ ...binary, bytes: new Uint8Array(8 * 1024 * 1024 + 1) }] },
	])("refuses over-limit output before reserving", async ({ files }) => {
		const { ctx, producer } = makeWriter();
		await expect(files_ingestion_write(ctx, scope, files, producer)).rejects.toThrow("at most eight");
		expect(producer.prepare).not.toHaveBeenCalled();
	});

	test.each([new Uint8Array([255]), new Uint8Array([0]), new Uint8Array(900_001)])(
		"keeps invalid or over-limit declared text as exact stored bytes",
		async (bytes) => {
			const { ctx, producer } = makeWriter();
			await files_ingestion_write(ctx, scope, [{ path: "/file.txt", contentType: "text/plain", bytes }], producer);
			expect(producer.prepare.mock.calls[0]?.[0].content).toEqual({ kind: "stored" });
			expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBe(bytes);
		},
	);

	test("keeps Markdown as exact bytes when its canonical text exceeds the cap", async () => {
		const { ctx, producer } = makeWriter();
		const bytes = new TextEncoder().encode("a".repeat(900_000));
		expect(
			(
				await files_ingestion_write(ctx, scope, [{ path: "/large.md", contentType: "text/markdown", bytes }], producer)
			)[0]?.status,
		).toBe("succeeded");
		expect(producer.prepare.mock.calls[0]?.[0].content).toEqual({ kind: "stored" });
		expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBe(bytes);
	});

	test("stages valid text with sealed family ids and canonical text, without an R2 PUT", async () => {
		const { ctx, producer, runMutation, runQuery } = makeWriter();
		const batchId = "batch-1" as Id<"files_pending_update_operation_batches">;
		producer.prepare.mockResolvedValue({
			_yay: {
				kind: "text",
				receiptId: prepared.receiptId,
				target: file.target,
				pendingUpdateId: "pending-1" as Id<"files_pending_updates">,
				operationBatchId: batchId,
				expectedRevision: 1,
				textKind: "plain_text",
			},
		});
		runQuery.mockResolvedValue({ _yay: { operationBatchId: batchId } });
		runMutation.mockImplementation(async (reference, args) => {
			const name = getFunctionName(reference as FunctionReference<"mutation">);
			if (name.endsWith("stage_file_pending_update_state_page_internal")) return { _yay: null };
			if (name.endsWith("seal_file_pending_update_state_internal"))
				return { _yay: { stateId: `state-${args.role}`, digest: `digest-${args.role}` } };
			throw new Error("Unexpected mutation");
		});
		const results = await files_ingestion_write(
			ctx,
			scope,
			[{ path: "/file.txt", contentType: "text/plain", bytes: new TextEncoder().encode("\uFEFFhello\r\nworld") }],
			producer,
		);
		expect(results[0]?.status).toBe("succeeded");
		expect(producer.prepare.mock.calls[0]?.[0].content).toEqual({ kind: "text", textKind: "plain_text" });
		expect(producer.finalize.mock.calls[0]?.[0].text).toMatchObject({
			unstagedText: "hello\nworld",
			family: {
				operationBatchId: batchId,
				baseStateId: "state-base",
				stagedStateId: "state-staged",
				unstagedStateId: "state-unstaged",
			},
		});
		expect(runQuery.mock.calls[0]?.[1]).not.toHaveProperty("threadId");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("files_ingestion_decode_base64", () => {
	test("decodes 8 MiB without changing arbitrary bytes", () => {
		const bytes = Uint8Array.from({ length: 8 * 1024 * 1024 }, (_, index) => index % 256);
		expect(Buffer.compare(files_ingestion_decode_base64(Buffer.from(bytes).toString("base64")), bytes)).toBe(0);
	});
	test.each(["a", "AA", "AA==x", "!!!!"])("refuses invalid base64 %s", (value) => {
		expect(() => files_ingestion_decode_base64(value)).toThrow();
	});
});
