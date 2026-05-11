import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
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
			r2Bucket: "test-files-bucket",
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
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
