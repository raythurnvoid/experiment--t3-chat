import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";

beforeEach(() => {
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/${encodeURIComponent(key)}`,
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mock_modal_converter(markdown = "# Converted\n\nPDF body") {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		return new Response(
			JSON.stringify({
				markdown,
				converter: "markitdown",
				request: init?.body ? JSON.parse(String(init.body)) : null,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	});
}

describe("files_content.convert_upload_to_markdown", () => {
	test("archives an unexpected active shadow-path occupant before creating the conversion shadow", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		vi.stubGlobal("fetch", mock_modal_converter());

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "collision.pdf",
			contentType: "application/pdf",
			size: 4096,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const existingShadowId = await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "collision.pdf.shadow.md",
				kind: "file",
				path: "/collision.pdf.shadow.md",
			}),
		);

		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});

		const docs = await t.run(async (ctx) => {
			const uploadDoc = await ctx.db.get("files_uploads", upload._yay.uploadId);
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = source?.assetId ? await ctx.db.get("files_r2_assets", source.assetId) : null;
			const oldShadow = await ctx.db.get("files_nodes", existingShadowId);
			const newShadow = asset?.shadowNodeId ? await ctx.db.get("files_nodes", asset.shadowNodeId) : null;
			const activeShadowAtPath = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("path", "/collision.pdf.shadow.md")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return { uploadDoc, source, asset, oldShadow, newShadow, activeShadowAtPath };
		});

		expect(docs.uploadDoc).toMatchObject({
			status: "finalized",
		});
		expect(docs.source?.assetId).toBe(docs.asset?._id);
		expect(docs.oldShadow?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.newShadow?._id).not.toBe(existingShadowId);
		expect(docs.newShadow).toMatchObject({
			name: "collision.pdf.shadow.md",
		});
		expect(docs.newShadow?.archiveOperationId).toBeUndefined();
		expect(docs.activeShadowAtPath?._id).toBe(docs.newShadow?._id);
	});

	test("records the converter failure and keeps the upload retryable", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("failed", { status: 500 })),
		);

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "broken.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		await expect(
			t.action(internal.files_content.convert_upload_to_markdown, {
				uploadId: upload._yay.uploadId,
			}),
		).rejects.toThrow("Failed to convert uploaded file");

		const nextUploadDoc = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		expect(nextUploadDoc).toMatchObject({
			status: "converting",
			failureMessage: "Modal file converter failed",
		});
	});

	test("finalizes with an archived shadow when the source is archived before conversion", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		vi.stubGlobal("fetch", mock_modal_converter());

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "archived.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [upload._yay.nodeId],
		});

		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});

		const docs = await t.run(async (ctx) => {
			const nextUploadDoc = await ctx.db.get("files_uploads", upload._yay.uploadId);
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = source?.assetId ? await ctx.db.get("files_r2_assets", source.assetId) : null;
			const shadow = asset?.shadowNodeId ? await ctx.db.get("files_nodes", asset.shadowNodeId) : null;
			return { nextUploadDoc, source, asset, shadow };
		});
		expect(docs.nextUploadDoc?.status).toBe("finalized");
		expect(docs.source?.assetId).toBe(docs.asset?._id);
		expect(docs.source?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.shadow?.archiveOperationId).toBe(docs.source?.archiveOperationId);
	});
});
