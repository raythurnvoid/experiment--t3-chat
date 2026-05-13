import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

function mock_modal_converter(markdown = "# Converted\n\nPDF body") {
	return vi.fn(async () => {
		return new Response(
			JSON.stringify({
				markdown,
				converter: "markitdown",
				warnings: [],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	});
}

function r2_event_args(upload: Doc<"files_uploads">) {
	return {
		cloudflareMessageId: "message_1",
		attempts: 1,
		event: {
			action: "object-create",
			bucket: upload.r2Bucket,
			object: {
				key: upload.r2Key,
				...(upload.size === undefined ? {} : { size: upload.size }),
				eTag: "etag_1",
			},
			eventTime: "2026-05-11T00:00:00.000Z",
		},
	};
}

describe("r2.generate_upload_url", () => {
	test("creates a files_uploads row and keeps the R2 key opaque", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.r2.generate_upload_url, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		expect(upload._yay).not.toHaveProperty("key");
		expect(upload._yay.headers).toEqual({ "Content-Type": "application/pdf" });

		const uploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		expect(uploadRow).toMatchObject({
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			parentId: files_ROOT_ID,
			r2Bucket: "test-files-bucket",
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
			status: "pending",
			conversionAttempts: 0,
		});
		expect(uploadRow?.r2Key).toMatch(/^workspaces\/.+\/projects\/.+\/uploads\/[0-9a-f-]+$/);
		expect(uploadRow?.r2Key).not.toContain("annual-report.pdf");
	});
});

describe("files_content.finalize_upload", () => {
	test("finalizes from the files_uploads row and creates source and shadow files", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const fetchMock = mock_modal_converter();
		vi.stubGlobal("fetch", fetchMock);

		const upload = await asUser.mutation(api.r2.generate_upload_url, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "sample.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		const finalized = await asUser.action(api.files_content.finalize_upload, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			uploadId: upload._yay.uploadId,
		});
		if (finalized._nay) {
			throw new Error(finalized._nay.message);
		}

		const rows = await t.run(async (ctx) => {
			const uploadRow = await ctx.db.get("files_uploads", upload._yay.uploadId);
			const asset = await ctx.db.get("files_r2_assets", finalized._yay.assetId);
			const source = await ctx.db.get("files_nodes", finalized._yay.sourceNodeId);
			const shadow = await ctx.db.get("files_nodes", finalized._yay.shadowNodeId);
			const shadowContent = shadow?.markdownContentId
				? await ctx.db.get("files_markdown_content", shadow.markdownContentId)
				: null;

			return { uploadRow, asset, source, shadow, shadowContent };
		});

		expect(rows.uploadRow?.assetId).toBe(finalized._yay.assetId);
		expect(rows.uploadRow?.sourceNodeId).toBe(finalized._yay.sourceNodeId);
		expect(rows.uploadRow?.shadowNodeId).toBe(finalized._yay.shadowNodeId);
		expect(rows.uploadRow?.finalizedAt).toEqual(expect.any(Number));
		expect(rows.uploadRow?.status).toBe("finalized");
		expect(rows.asset?.r2Key).toBe(rows.uploadRow?.r2Key);
		expect(rows.source).toMatchObject({
			name: "sample.pdf",
			kind: "file",
			fileStorageKind: "r2",
		});
		expect(rows.shadow).toMatchObject({
			name: "sample.pdf.shadow.md",
			kind: "file",
			fileStorageKind: "markdown",
		});
		expect(rows.shadowContent?.content).toContain("# Converted");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rejects an upload from another membership", async () => {
		const t = test_convex();
		const dbOne = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const dbTwo = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "other-workspace",
				projectName: "other-project",
			}),
		);
		const asUserOne = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dbOne.userId,
			name: "Test User One",
		});
		const asUserTwo = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dbTwo.userId,
			name: "Test User Two",
		});

		const upload = await asUserOne.mutation(api.r2.generate_upload_url, {
			membershipId: dbOne.membershipId,
			parentId: files_ROOT_ID,
			filename: "sample.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		const finalized = await asUserTwo.action(api.files_content.finalize_upload, {
			membershipId: dbTwo.membershipId,
			parentId: files_ROOT_ID,
			uploadId: upload._yay.uploadId,
		});

		expect(finalized._nay?.message).toBe("Unauthorized");
	});

	test("rejects expired uploads", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.r2.generate_upload_url, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "sample.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch(upload._yay.uploadId, {
				expiresAt: Date.now() - 1,
			});
		});

		const finalized = await asUser.action(api.files_content.finalize_upload, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			uploadId: upload._yay.uploadId,
		});

		expect(finalized._nay?.message).toBe("Upload expired");
	});

});

describe("files_content.finalize_upload_from_r2_event", () => {
	test("finalizes by bucket and key", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const fetchMock = mock_modal_converter();
		vi.stubGlobal("fetch", fetchMock);

		const upload = await asUser.mutation(api.r2.generate_upload_url, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "event.pdf",
			contentType: "application/pdf",
			size: 4096,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const uploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		if (!uploadRow) {
			throw new Error("Upload row not found");
		}

		const finalized = await t.action(internal.files_content.finalize_upload_from_r2_event, r2_event_args(uploadRow));

		if (finalized._nay) {
			throw new Error(finalized._nay.message);
		}
		expect(finalized._yay.type).toBe("finalized");

		const rows = await t.run(async (ctx) => {
			const nextUploadRow = await ctx.db.get("files_uploads", upload._yay.uploadId);
			const source =
				finalized._yay.type === "finalized" ? await ctx.db.get("files_nodes", finalized._yay.sourceNodeId) : null;
			const shadow =
				finalized._yay.type === "finalized" ? await ctx.db.get("files_nodes", finalized._yay.shadowNodeId) : null;

			return { nextUploadRow, source, shadow };
		});

		expect(rows.nextUploadRow).toMatchObject({
			status: "finalized",
			parentId: files_ROOT_ID,
			conversionAttempts: 1,
			r2EventCloudflareMessageId: "message_1",
			r2EventAction: "object-create",
			r2EventTime: "2026-05-11T00:00:00.000Z",
			r2EventSize: 4096,
			r2EventEtag: "etag_1",
		});
		expect(rows.source?.name).toBe("event.pdf");
		expect(rows.shadow?.name).toBe("event.pdf.shadow.md");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("returns existing ids for duplicate finalized events", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const fetchMock = mock_modal_converter();
		vi.stubGlobal("fetch", fetchMock);

		const upload = await asUser.mutation(api.r2.generate_upload_url, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "duplicate.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const uploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		if (!uploadRow) {
			throw new Error("Upload row not found");
		}

		const first = await t.action(internal.files_content.finalize_upload_from_r2_event, r2_event_args(uploadRow));
		const second = await t.action(internal.files_content.finalize_upload_from_r2_event, {
			...r2_event_args(uploadRow),
			cloudflareMessageId: "message_2",
			attempts: 2,
		});

		if (first._nay) {
			throw new Error(first._nay.message);
		}
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(first._yay).toEqual(second._yay);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("marks conversion failures as retryable failed uploads", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response("failed", { status: 500 })));

		const upload = await asUser.mutation(api.r2.generate_upload_url, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "broken.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const uploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		if (!uploadRow) {
			throw new Error("Upload row not found");
		}

		const result = await t.action(internal.files_content.finalize_upload_from_r2_event, r2_event_args(uploadRow));

		expect(result._nay).toMatchObject({
			message: "Modal file converter failed",
			data: {
				retryable: true,
			},
		});

		const nextUploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		expect(nextUploadRow).toMatchObject({
			status: "failed",
			conversionAttempts: 1,
			failureMessage: "Modal file converter failed",
		});
	});

	test("ignores events without a matching upload row", async () => {
		const t = test_convex();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await t.action(internal.files_content.finalize_upload_from_r2_event, {
			cloudflareMessageId: "message_1",
			attempts: 1,
			event: {
				action: "object-create",
				bucket: "test-files-bucket",
				object: {
					key: "workspaces/workspace_1/projects/project_1/uploads/missing",
					size: 1,
					eTag: "etag_1",
				},
				eventTime: "2026-05-11T00:00:00.000Z",
			},
		});

		expect(result).toEqual({
			_yay: {
				type: "ignored",
				reason: "Upload row not found",
			},
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("marks legacy rows without a parent as non-retryable failures", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const uploadId = await t.run(async (ctx) =>
			ctx.db.insert("files_uploads", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				createdBy: db.userId,
				r2Bucket: "test-files-bucket",
				r2Key: "workspaces/workspace_1/projects/project_1/uploads/legacy",
				filename: "legacy.pdf",
				contentType: "application/pdf",
				size: 1024,
				createdAt: Date.now(),
				expiresAt: Date.now() + 60_000,
			}),
		);
		const uploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", uploadId));
		if (!uploadRow) {
			throw new Error("Upload row not found");
		}

		const result = await t.action(internal.files_content.finalize_upload_from_r2_event, r2_event_args(uploadRow));

		expect(result._nay).toMatchObject({
			message: "Legacy upload row has no parent; manual re-upload is required",
			data: {
				retryable: false,
			},
		});

		const nextUploadRow = await t.run(async (ctx) => ctx.db.get("files_uploads", uploadId));
		expect(nextUploadRow).toMatchObject({
			status: "failed",
			failureMessage: "Legacy upload row has no parent; manual re-upload is required",
		});
	});
});
