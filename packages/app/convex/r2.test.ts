import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";

beforeEach(() => {
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string) => `https://r2.test/${encodeURIComponent(key)}`);
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

type R2EventRouteBody =
	| {
			type: "in_progress";
			retryAfterMs: number;
	  }
	| {
			type: "queued";
			uploadId: string;
			sourceNodeId: string;
	  }
	| {
			type: "finalized";
			assetId: string;
			sourceNodeId: string;
			shadowNodeId: string;
	  }
	| {
			message: string;
	  };

async function fetch_r2_event(t: ReturnType<typeof test_convex>, body: ReturnType<typeof r2_event_args>) {
	const response = await t.fetch("/api/r2/event", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	return {
		response,
		body: (await response.json()) as R2EventRouteBody,
	};
}

describe("r2 event HTTP route", () => {
	test("queues by bucket and key, then conversion finalizes the current source node", async () => {
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
		const queued = await fetch_r2_event(t, r2_event_args(uploadDoc));

		expect(queued.response.status).toBe(200);
		expect(queued.body).toMatchObject({
			type: "queued",
			uploadId: upload._yay.uploadId,
			sourceNodeId: upload._yay.nodeId,
		});
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);

		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});

		const docs = await t.run(async (ctx) => {
			const nextUploadDoc = await ctx.db.get("files_uploads", upload._yay.uploadId);
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = source?.assetId ? await ctx.db.get("files_r2_assets", source.assetId) : null;
			const shadow = asset ? await ctx.db.get("files_nodes", asset.shadowNodeId) : null;
			return { nextUploadDoc, asset, source, shadow };
		});

		expect(docs.nextUploadDoc).toMatchObject({
			status: "finalized",
		});
		expect(docs.nextUploadDoc?.conversionWorkId).toBeUndefined();
		expect(docs.source?.assetId).toBe(docs.asset?._id);
		expect(docs.asset?.sourceNodeId).toBe(upload._yay.nodeId);
		expect(docs.source).toMatchObject({
			parentId: folder._yay.nodeId,
			name: "event-renamed.pdf",
		});
		expect(docs.shadow).toMatchObject({
			parentId: folder._yay.nodeId,
			name: "event-renamed.pdf.shadow.md",
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

		const first = await fetch_r2_event(t, r2_event_args(uploadDoc));
		const second = await fetch_r2_event(t, {
			...r2_event_args(uploadDoc),
			cloudflareMessageId: "message_2",
			attempts: 2,
		});
		await t.action(internal.files_content.convert_upload_to_markdown, {
			uploadId: upload._yay.uploadId,
		});
		const third = await fetch_r2_event(t, {
			...r2_event_args(uploadDoc),
			cloudflareMessageId: "message_3",
			attempts: 3,
		});

		expect(first.response.status).toBe(200);
		expect(first.body).toMatchObject({ type: "queued" });
		expect(second.response.status).toBe(202);
		expect(second.body).toMatchObject({ type: "in_progress" });
		expect(third.response.status).toBe(200);
		expect(third.body).toMatchObject({ type: "finalized" });
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const assets = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_assets")
				.withIndex("by_workspace_project_sourceNode", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("sourceNodeId", upload._yay.nodeId),
				)
				.collect(),
		);
		expect(assets).toHaveLength(1);
	});

	test("returns not found for events without a matching upload doc", async () => {
		const t = test_convex();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetch_r2_event(t, {
			cloudflareMessageId: "message_1",
			attempts: 1,
			event: {
				action: "object-create",
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
