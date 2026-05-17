import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID, files_get_utf8_byte_size } from "../server/files.ts";

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

function r2_event_args(upload: Doc<"files_uploads">, size?: number) {
	return {
		cloudflareMessageId: "message_1",
		attempts: 1,
		event: {
			action: "PutObject",
			bucket: upload.r2Bucket,
			object: {
				key: upload.r2Key,
				...(size === undefined ? {} : { size }),
				eTag: "etag_1",
			},
			eventTime: "2026-05-11T00:00:00.000Z",
		},
	};
}

type R2EventRouteBody = { message: string } | null;

async function fetch_r2_event(t: ReturnType<typeof test_convex>, body: ReturnType<typeof r2_event_args>) {
	const response = await t.fetch("/api/r2/event", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const responseBody = await response.text();
	return {
		response,
		body: responseBody ? (JSON.parse(responseBody) as R2EventRouteBody) : null,
	};
}

describe("r2 event HTTP route", () => {
	test("queues by bucket and key, then conversion finalizes the current source file node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const fetchMock = mock_modal_converter();
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_upload_conversion" as never);
		vi.stubGlobal("fetch", fetchMock);

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "event.pdf",
			contentType: "application/pdf",
			size: 4096,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "received",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", upload._yay.nodeId, {
				parentId: folder._yay.nodeId,
				name: "event-renamed.pdf",
				path: "/received/event-renamed.pdf",
			});
		});

		const uploadDoc = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		if (!uploadDoc) {
			throw new Error("Upload doc not found");
		}
		const queued = await fetch_r2_event(t, r2_event_args(uploadDoc, 8192));

		expect(queued.response.status).toBe(204);
		expect(queued.body).toBeNull();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const uploadedDocs = await t.run(async (ctx) => {
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = source?.assetId ? await ctx.db.get("files_r2_assets", source.assetId) : null;
			const properties = source?.propertiesId ? await ctx.db.get("files_node_properties", source.propertiesId) : null;
			return { asset, properties, source };
		});
		expect(uploadedDocs.source?.assetId).toBe(uploadedDocs.asset?._id);
		expect(uploadedDocs.asset).toMatchObject({
			sourceNodeId: upload._yay.nodeId,
			r2Key: uploadDoc.r2Key,
		});
		expect(uploadedDocs.asset).not.toHaveProperty("contentType");
		expect(uploadedDocs.asset).not.toHaveProperty("size");
		expect(uploadedDocs.properties).toMatchObject({
			contentType: "application/pdf",
			size: 8192,
		});
		expect(uploadedDocs.source?.shadowFileNodeIds).toEqual([]);

		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});

		const docs = await t.run(async (ctx) => {
			const nextUploadDoc = await ctx.db.get("files_uploads", upload._yay.uploadId);
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = source?.assetId ? await ctx.db.get("files_r2_assets", source.assetId) : null;
			const shadowId = source?.shadowFileNodeIds[0];
			const shadow = shadowId ? await ctx.db.get("files_nodes", shadowId) : null;
			return { nextUploadDoc, asset, source, shadow };
		});

		expect(docs.nextUploadDoc?.conversionWorkId).toBeUndefined();
		expect(docs.nextUploadDoc?.failureMessage).toBeUndefined();
		expect(docs.source?.assetId).toBe(docs.asset?._id);
		expect(docs.asset?._id).toBe(uploadedDocs.asset?._id);
		expect(docs.source?.shadowFileNodeIds).toContain(docs.shadow?._id);
		expect(docs.asset?.sourceNodeId).toBe(upload._yay.nodeId);
		expect(docs.source).toMatchObject({
			parentId: folder._yay.nodeId,
			name: "event-renamed.pdf",
		});
		expect(docs.shadow).toMatchObject({
			parentId: folder._yay.nodeId,
			name: "event-renamed.pdf.shadow.md",
			shadowSourceFileNodeId: upload._yay.nodeId,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("does not create duplicate assets or jobs for duplicate events", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_upload_conversion" as never);
		vi.stubGlobal("fetch", mock_modal_converter());

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "duplicate.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const uploadDoc = await t.run(async (ctx) => ctx.db.get("files_uploads", upload._yay.uploadId));
		if (!uploadDoc) {
			throw new Error("Upload doc not found");
		}

		const first = await fetch_r2_event(t, r2_event_args(uploadDoc, 1024));
		const second = await fetch_r2_event(t, {
			...r2_event_args(uploadDoc, 1024),
			cloudflareMessageId: "message_2",
			attempts: 2,
		});
		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});
		const third = await fetch_r2_event(t, {
			...r2_event_args(uploadDoc, 1024),
			cloudflareMessageId: "message_3",
			attempts: 3,
		});

		expect(first.response.status).toBe(204);
		expect(first.body).toBeNull();
		expect(second.response.status).toBe(204);
		expect(second.body).toBeNull();
		expect(third.response.status).toBe(204);
		expect(third.body).toBeNull();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const assets = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_assets")
				.withIndex("by_workspace_project_r2Key", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("r2Key", uploadDoc.r2Key),
				)
				.collect(),
		);
		expect(assets).toHaveLength(1);
		expect(assets[0]?.sourceNodeId).toBe(upload._yay.nodeId);
	});

	test("returns not found for events without a matching upload doc", async () => {
		const t = test_convex();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetch_r2_event(t, {
			cloudflareMessageId: "message_1",
			attempts: 1,
			event: {
				action: "PutObject",
				bucket: "test-files-bucket",
				object: {
					key: "workspaces/workspace_1/projects/project_1/nodes/missing/source",
					size: 1,
					eTag: "etag_1",
				},
				eventTime: "2026-05-11T00:00:00.000Z",
			},
		});

		expect(result.response.status).toBe(404);
		expect(result.body).toEqual({
			message: "Upload doc not found",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("r2 file downloads", () => {
	test("prepares a saved Markdown file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const markdownFile = await asUser.mutation(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "notes.md",
		});
		if (markdownFile._nay) {
			throw new Error(markdownFile._nay.message);
		}
		const savedMarkdown = "# Saved\n\nOnly committed content is downloadable.";
		const savedMarkdownSize = files_get_utf8_byte_size(savedMarkdown);
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", markdownFile._yay.nodeId);
			if (!node?.markdownContentId) {
				throw new Error("Expected Markdown node to have content");
			}
			await ctx.db.patch("files_markdown_content", node.markdownContentId, {
				content: savedMarkdown,
			});
			if (!node.propertiesId) {
				throw new Error("Expected Markdown node properties");
			}
			await ctx.db.patch("files_node_properties", node.propertiesId, {
				size: savedMarkdownSize,
			});
		});

		const prepared = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: markdownFile._yay.nodeId,
		});
		expect(prepared).toEqual({
			_yay: {
				kind: "text",
				filename: "notes.md",
				contentType: "text/markdown;charset=utf-8",
				size: savedMarkdownSize,
				content: savedMarkdown,
			},
		});
	});

	test("prepares original PDF plus generated Markdown after conversion", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const convertedMarkdown = "# Converted\n\nPDF body searchable";
		const convertedMarkdownSize = files_get_utf8_byte_size(convertedMarkdown);
		vi.stubGlobal("fetch", mock_modal_converter(convertedMarkdown));

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "report.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});

		const shadowNodeId = await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const nodeId = sourceNode?.shadowFileNodeIds[0];
			if (!nodeId) {
				throw new Error("Expected generated Markdown shadow node");
			}

			return nodeId;
		});

		const source = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(source).toMatchObject({
			_yay: {
				kind: "url",
				filename: "report.pdf",
				contentType: "application/pdf",
				size: 1024,
			},
		});
		expect(source._yay?.kind === "url" ? source._yay.url : "").toContain("https://r2.test/");
		expect(JSON.stringify(source)).not.toContain("r2Key");

		const markdown = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: shadowNodeId,
		});
		expect(markdown).toEqual({
			_yay: {
				kind: "text",
				filename: "report.pdf.shadow.md",
				contentType: "text/markdown;charset=utf-8",
				size: convertedMarkdownSize,
				content: convertedMarkdown,
			},
		});

		await expect(
			asUser.action(api.r2.prepare_file_download_target, {
				membershipId: db.membershipId,
				fileNodeId: shadowNodeId,
			}),
		).resolves.toEqual(markdown);
	});

	test("prepares archived source and generated Markdown downloads", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const convertedMarkdown = "# Archived\n\nStill downloadable";
		vi.stubGlobal("fetch", mock_modal_converter(convertedMarkdown));

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

		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});

		const shadowNodeId = await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const nodeId = sourceNode?.shadowFileNodeIds[0];
			if (!nodeId) {
				throw new Error("Expected generated Markdown shadow node");
			}

			return nodeId;
		});

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [upload._yay.nodeId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}

		const source = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(source).toMatchObject({
			_yay: {
				kind: "url",
				filename: "archived.pdf",
			},
		});

		const markdown = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: shadowNodeId,
		});
		expect(markdown).toEqual({
			_yay: {
				kind: "text",
				filename: "archived.pdf.shadow.md",
				contentType: "text/markdown;charset=utf-8",
				size: files_get_utf8_byte_size(convertedMarkdown),
				content: convertedMarkdown,
			},
		});
	});

	test("prepares original source once an upload has an asset but no conversion shadow", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "pending.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.mutation(internal.r2.ensure_uploaded_asset, {
			uploadId: upload._yay.uploadId,
			size: 2048,
		});

		const source = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(source).toMatchObject({
			_yay: {
				kind: "url",
				filename: "pending.pdf",
				contentType: "application/pdf",
				size: 2048,
			},
		});
		expect(source._yay?.kind === "url" ? source._yay.url : "").toContain("https://r2.test/");
	});

	test("rejects a pending upload source before an asset exists", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "pending.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		const source = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(source._nay?.message).toBe("Not found");
	});

	test("rejects folder downloads with an explicit message", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "folder-download",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const prepared = await asUser.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: folder._yay.nodeId,
		});
		expect(prepared._nay?.message).toBe("Cannot download a folder");
	});

	test("keeps authorization failures separate from requested file not-found responses", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const markdownFile = await asOwner.mutation(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "auth-order.md",
		});
		if (markdownFile._nay) {
			throw new Error(markdownFile._nay.message);
		}

		await t.run(async (ctx) => {
			await ctx.db.delete("workspaces", db.workspaceId);
		});
		const missingWorkspace = await asOwner.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: markdownFile._yay.nodeId,
		});
		expect(missingWorkspace._nay?.message).toBe("Unauthorized");
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Membership points to missing workspace",
			expect.objectContaining({
				membershipId: db.membershipId,
				workspaceId: db.workspaceId,
				projectId: db.projectId,
			}),
		);

		const db2 = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner2 = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db2.userId,
			name: "Second Test User",
		});
		const missingFile = await asOwner2.mutation(api.files_nodes.create_markdown_node, {
			membershipId: db2.membershipId,
			parentId: files_ROOT_ID,
			name: "missing-file.md",
		});
		if (missingFile._nay) {
			throw new Error(missingFile._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.delete("files_nodes", missingFile._yay.nodeId);
		});

		const missingFilePrepare = await asOwner2.action(api.r2.prepare_file_download_target, {
			membershipId: db2.membershipId,
			fileNodeId: missingFile._yay.nodeId,
		});
		expect(missingFilePrepare._nay?.message).toBe("Not found");
	});

	test("throws should_never_happen when a source file points to a missing asset", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "broken-asset.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const asset = await t.mutation(internal.r2.ensure_uploaded_asset, {
			uploadId: upload._yay.uploadId,
			size: 2048,
		});

		await t.run(async (ctx) => {
			await ctx.db.delete("files_r2_assets", asset._yay._id);
		});

		await expect(
			asUser.action(api.r2.prepare_file_download_target, {
				membershipId: db.membershipId,
				fileNodeId: upload._yay.nodeId,
			}),
		).rejects.toThrow("File node asset missing");
	});

	test("throws should_never_happen when a Markdown file points to missing content", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const markdownFile = await asUser.mutation(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "broken-content.md",
		});
		if (markdownFile._nay) {
			throw new Error(markdownFile._nay.message);
		}
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", markdownFile._yay.nodeId);
			if (!node?.markdownContentId) {
				throw new Error("Expected Markdown node content");
			}
			await ctx.db.delete("files_markdown_content", node.markdownContentId);
		});

		await expect(
			asUser.action(api.r2.prepare_file_download_target, {
				membershipId: db.membershipId,
				fileNodeId: markdownFile._yay.nodeId,
			}),
		).rejects.toThrow("File node markdown content missing");
	});

	test("throws should_never_happen when a Markdown file points to missing properties", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const markdownFile = await asUser.mutation(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "broken-properties.md",
		});
		if (markdownFile._nay) {
			throw new Error(markdownFile._nay.message);
		}
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", markdownFile._yay.nodeId);
			if (!node?.propertiesId) {
				throw new Error("Expected Markdown node properties");
			}
			await ctx.db.delete("files_node_properties", node.propertiesId);
		});

		await expect(
			asUser.action(api.r2.prepare_file_download_target, {
				membershipId: db.membershipId,
				fileNodeId: markdownFile._yay.nodeId,
			}),
		).rejects.toThrow("File node properties missing");
	});

	test("requires the caller membership and asset.read permission", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const markdownFile = await asOwner.mutation(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "private.md",
		});
		if (markdownFile._nay) {
			throw new Error(markdownFile._nay.message);
		}

		const otherUserId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		const asOther = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: otherUserId,
			name: "Other User",
		});
		const unauthorizedPrepare = await asOther.action(api.r2.prepare_file_download_target, {
			membershipId: db.membershipId,
			fileNodeId: markdownFile._yay.nodeId,
		});
		expect(unauthorizedPrepare._nay?.message).toBe("Unauthorized");

		const deniedMember = await t.run(async (ctx) => {
			const now = Date.now();
			const memberUserId = await ctx.db.insert("users", {
				clerkUserId: null,
			});
			const memberMembershipId = await ctx.db.insert("workspaces_projects_users", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: memberUserId,
			});
			await ctx.db.insert("access_control_role_assignments", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: memberUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			const memberAssetReadGrants = await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_workspace_project_resource_role_permission", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("resourceKind", "project")
						.eq("resourceId", String(db.projectId))
						.eq("principalKind", "role")
						.eq("role", "member")
						.eq("permission", "asset.read"),
				)
				.collect();
			await Promise.all(
				memberAssetReadGrants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)),
			);

			return { memberUserId, memberMembershipId };
		});
		const asDeniedMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: deniedMember.memberUserId,
			name: "Denied Member",
		});

		const deniedPrepare = await asDeniedMember.action(api.r2.prepare_file_download_target, {
			membershipId: deniedMember.memberMembershipId,
			fileNodeId: markdownFile._yay.nodeId,
		});
		expect(deniedPrepare._nay?.message).toBe("Permission denied");

		await t.run(async (ctx) => {
			await ctx.db.delete("files_nodes", markdownFile._yay.nodeId);
		});
		const deniedMissingFilePrepare = await asDeniedMember.action(api.r2.prepare_file_download_target, {
			membershipId: deniedMember.memberMembershipId,
			fileNodeId: markdownFile._yay.nodeId,
		});
		expect(deniedMissingFilePrepare._nay?.message).toBe("Permission denied");
	});
});
