import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { internal } from "./_generated/api.js";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_MAX_UPLOADS_BYTES, files_ROOT_ID } from "../server/files.ts";

let enqueueActionSpy: MockInstance;
let generateUploadUrlSpy: ReturnType<typeof vi.fn<(customKey?: string) => Promise<{ key: string; url: string }>>>;

beforeEach(() => {
	enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_data_import_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	generateUploadUrlSpy = vi.fn(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(generateUploadUrlSpy);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("data_import.create_upload_targets", () => {
	test("creates nested nodes and suppressed assets with presigned urls", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [
				{ path: "/meetings/team-sync/video.mp4", contentType: "video/mp4", size: 1234 },
				{ path: "/documents/report.pdf", contentType: "application/pdf", size: 4321 },
			],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		expect(created._yay).toHaveLength(2);
		expect(created._yay[0]).toMatchObject({
			path: "/meetings/team-sync/video.mp4",
			uploadUrl: "https://r2.test/upload",
			headers: { "Content-Type": "video/mp4" },
		});

		const docs = await t.run(async (ctx) => {
			const video = await ctx.db.get("files_nodes", created._yay[0]!.nodeId);
			const videoAsset = await ctx.db.get("files_r2_assets", created._yay[0]!.assetId);
			const meetingsFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/meetings/team-sync")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return { video, videoAsset, meetingsFolder };
		});
		expect(docs.video).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			path: "/meetings/team-sync/video.mp4",
			kind: "file",
			contentType: "video/mp4",
			assetId: created._yay[0]!.assetId,
			createdBy: db.userId,
		});
		expect(docs.meetingsFolder).toMatchObject({ kind: "folder" });
		expect(docs.videoAsset).toMatchObject({
			kind: "upload",
			size: 1234,
			createdBy: db.userId,
			processingWorkId: null,
		});
		expect(docs.videoAsset?.r2Key).toBeUndefined();
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${created._yay[0]!.assetId}`,
		);
	});

	test("finalizing an imported Markdown asset records the object without starting processing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/notes.md", contentType: "text/markdown;charset=utf-8", size: 64 }],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const assetId = created._yay[0]!.assetId;
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		const assetR2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`;
		const uploadStagingR2Key =
			asset?.uploadStagingR2Key ??
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${assetId}`;
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		// The staged object exists only in this stub: report it copied so the event can finalize.
		// Enforce the expected-identity contract like the real action, so a garbled expectedSource
		// from the event route fails here instead of staying green.
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, copyArgs) => {
			if (copyArgs.sourceKey !== uploadStagingR2Key) {
				return { outcome: "source_missing" as const };
			}
			if (copyArgs.expectedSize !== 64 || copyArgs.expectedEtag !== "etag_data_import_1") {
				return { outcome: "source_changed" as const };
			}
			return { outcome: "copied" as const, size: 64, etag: "etag_data_import_1" };
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url === "https://r2.test/upload" && init?.method === "PUT") {
					return new Response(null, { status: 200 });
				}
				return new Response(null, { status: 404 });
			}),
		);

		enqueueActionSpy.mockClear();
		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "data_import_event_1",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset!.r2Bucket,
					object: {
						key: uploadStagingR2Key,
						size: 64,
						eTag: "etag_data_import_1",
					},
					eventTime: "2026-08-01T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const finalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(finalized?.r2Key).toBe(assetR2Key);
		expect(finalized?.processingWorkId).toBeNull();
		// With processingWorkId settled up front, the finalizer must not enqueue Markdown
		// conversion or any other processing work.
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("archives an existing file at the same path and replaces it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const first = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 100 }],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		const second = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 200 }],
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}

		expect(second._yay[0]!.nodeId).not.toBe(first._yay[0]!.nodeId);
		const docs = await t.run(async (ctx) => {
			const oldNode = await ctx.db.get("files_nodes", first._yay[0]!.nodeId);
			const activeNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/documents/report.pdf")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return { oldNode, activeNode };
		});
		expect(docs.oldNode?.archiveOperationId).toBeDefined();
		expect(docs.activeNode?._id).toBe(second._yay[0]!.nodeId);
	});

	test("refuses a locked replacement occupant and imports again after unlock", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const first = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 100 }],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const occupantNodeId = first._yay[0]!.nodeId;

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", occupantNodeId, {
				readOnlyScopeNodeId: occupantNodeId,
			});
		});

		// This operator import has no bypass for read-only locks.
		const refused = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 200 }],
		});
		expect(refused._nay).toMatchObject({
			name: "read_only",
			message: "This item is read-only.",
			data: { path: "/documents/report.pdf" },
		});

		const afterRefusal = await t.run(async (ctx) => {
			const occupant = await ctx.db.get("files_nodes", occupantNodeId);
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
				)
				.collect();
			return { occupant, assetCount: assets.length };
		});
		// The refusal created no node or asset, and the old file stays active.
		expect(afterRefusal.occupant?.archiveOperationId).toBeUndefined();
		expect(afterRefusal.assetCount).toBe(1);

		// Unlocking allows the same import to replace the old file.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", occupantNodeId, {
				readOnlyScopeNodeId: undefined,
			});
		});
		const retried = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 200 }],
		});
		if (retried._nay) {
			throw new Error(retried._nay.message);
		}
		expect(retried._yay).toHaveLength(1);
	});

	test("refuses importing under a locked destination folder", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const folder = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				parentId: files_ROOT_ID,
				path: "locked-dir",
				kind: "folder",
				now: Date.now(),
			});
			if (folder._nay) {
				throw new Error(folder._nay.message);
			}
			await ctx.db.patch("files_nodes", folder._yay, {
				readOnlyScopeNodeId: folder._yay,
			});
		});

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/locked-dir/nested/report.pdf", contentType: "application/pdf", size: 100 }],
		});

		expect(created._nay).toMatchObject({
			name: "read_only",
			message: "This item is read-only.",
			data: { path: "/locked-dir/nested/report.pdf" },
		});
		const after = await t.run(async (ctx) => {
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
				)
				.collect();
			const nested = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/locked-dir/nested")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return { assetCount: assets.length, nested };
		});
		expect(after.assetCount).toBe(0);
		expect(after.nested).toBeNull();
	});

	test("rejects a folder occupying the target path before any write", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const folder = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				parentId: files_ROOT_ID,
				path: "report.pdf",
				kind: "folder",
				now: Date.now(),
			});
			if (folder._nay) {
				throw new Error(folder._nay.message);
			}
		});

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/report.pdf", contentType: "application/pdf", size: 100 }],
		});

		expect(created._nay).toMatchObject({
			message: "The path cannot point to a folder",
			data: { path: "/report.pdf" },
		});
		const assets = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
				)
				.collect(),
		);
		expect(assets).toHaveLength(0);
	});

	test("rejects a file occupying an ancestor of the target path", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const blocker = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/archive.zip", contentType: "application/zip", size: 100 }],
		});
		if (blocker._nay) {
			throw new Error(blocker._nay.message);
		}

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/archive.zip/inner.pdf", contentType: "application/pdf", size: 100 }],
		});

		expect(created._nay).toMatchObject({
			message: "The path cannot point to a folder",
			data: { path: "/archive.zip/inner.pdf" },
		});
	});

	test("accepts a 100 MiB video and rejects a file over the upload cap", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const accepted = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/meetings/big/video.mp4", contentType: "video/mp4", size: 100 * 1024 * 1024 }],
		});
		expect(accepted._yay).toHaveLength(1);

		const rejected = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/meetings/huge/video.mp4", contentType: "video/mp4", size: files_MAX_UPLOADS_BYTES + 1 }],
		});
		expect(rejected._nay).toMatchObject({
			message: "File too large",
			data: { path: "/meetings/huge/video.mp4" },
		});
	});

	test("rejects a createdBy that is not the organization owner", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const otherUserId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: null }));

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: otherUserId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 100 }],
		});

		expect(created._nay).toMatchObject({ message: "Unauthorized" });
	});

	test("rejects a workspace from another organization", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const otherDb = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org" }),
		);

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: otherDb.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report.pdf", contentType: "application/pdf", size: 100 }],
		});

		expect(created._nay).toMatchObject({ message: "Not found" });
	});

	test("rejects non-normalized paths and names", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const doubleSlash = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents//report.pdf", contentType: "application/pdf", size: 100 }],
		});
		expect(doubleSlash._nay).toMatchObject({ message: "Path must be absolute and normalized" });

		const doubleUnderscore = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [{ path: "/documents/report__final.pdf", contentType: "application/pdf", size: 100 }],
		});
		expect(doubleUnderscore._nay).toMatchObject({ message: "Path ends in an invalid file name" });
	});

	test("rejects duplicate paths in one batch", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [
				{ path: "/documents/report.pdf", contentType: "application/pdf", size: 100 },
				{ path: "/documents/report.pdf", contentType: "application/pdf", size: 200 },
			],
		});

		expect(created._nay).toMatchObject({
			message: "Duplicate path in batch",
			data: { path: "/documents/report.pdf" },
		});
	});
});

describe("data_import.verify_run", () => {
	test("counts nodes, unfinalized assets, and plugin runs for the workspace", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.mutation(internal.data_import.create_upload_targets, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			items: [
				{ path: "/meetings/team-sync/video.mp4", contentType: "video/mp4", size: 1234 },
				{ path: "/documents/report.pdf", contentType: "application/pdf", size: 4321 },
			],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const before = await t.query(internal.data_import.verify_run, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
		});
		// 2 files + folders /meetings, /meetings/team-sync, /documents.
		expect(before).toMatchObject({
			nodes: { activeFiles: 2, activeFolders: 3, archived: 0 },
			assets: { total: 2, unfinalized: 2, unfinalizedActive: 2 },
			pluginEventRuns: 0,
		});

		// Simulate the R2 event finalizer confirming one uploaded object.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", created._yay[0]!.assetId, {
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${created._yay[0]!.assetId}`,
				updatedAt: Date.now(),
			});
		});

		const after = await t.query(internal.data_import.verify_run, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
		});
		expect(after.assets).toMatchObject({ total: 2, unfinalized: 1, unfinalizedActive: 1 });

		// An unfinalized asset that no active node references is workspace debris, not a
		// missing import: it must drop out of unfinalizedActive but stay in unfinalized.
		await t.run(async (ctx) => {
			await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-bucket",
				size: 10,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
		});
		const withOrphan = await t.query(internal.data_import.verify_run, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
		});
		expect(withOrphan.assets).toMatchObject({ total: 3, unfinalized: 2, unfinalizedActive: 1 });
	});
});

describe("data_import.verify_metadata", () => {
	test("counts committed metadata docs per path and returns null for missing paths", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const nodeId = await t.run(async (ctx) => {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				parentId: files_ROOT_ID,
				path: "/emails/thread/message.md",
				kind: "file",
				now: Date.now(),
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			const node = await ctx.db.get("files_nodes", created._yay);
			for (const qualifiedField of ["frontmatter.subject", "frontmatter.provider"]) {
				await ctx.db.insert("files_metadata_docs", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: created._yay,
					sourceKind: "committed",
					path: "/emails/thread/message.md",
					treePath: node!.treePath,
					qualifiedField,
					docKind: "field",
				});
			}
			return created._yay;
		});

		// A pending-source doc must not count as committed frontmatter.
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			await ctx.db.insert("files_metadata_docs", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sourceKind: "pending",
				path: "/emails/thread/message.md",
				treePath: node!.treePath,
				qualifiedField: "frontmatter.subject",
				docKind: "field",
			});
		});

		const results = await t.query(internal.data_import.verify_metadata, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			paths: ["/emails/thread/message.md", "/emails/thread/other.md"],
		});
		expect(results).toEqual([
			{ path: "/emails/thread/message.md", metadataDocs: 2 },
			{ path: "/emails/thread/other.md", metadataDocs: null },
		]);
	});

	// The same table also holds the `metadata.` map a user or an agent wrote next to the file. If
	// those counted, this check would pass for a file whose frontmatter never indexed.
	test("counts frontmatter docs only, not the file metadata written next to the file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		await t.run(async (ctx) => {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				parentId: files_ROOT_ID,
				path: "/emails/thread/message.md",
				kind: "file",
				now: Date.now(),
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			const node = await ctx.db.get("files_nodes", created._yay);
			for (const qualifiedField of ["frontmatter.subject", "metadata.created-by", "metadata.status"]) {
				await ctx.db.insert("files_metadata_docs", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: created._yay,
					sourceKind: "committed",
					path: "/emails/thread/message.md",
					treePath: node!.treePath,
					qualifiedField,
					docKind: "field",
				});
			}
		});

		const results = await t.query(internal.data_import.verify_metadata, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			paths: ["/emails/thread/message.md"],
		});
		expect(results).toEqual([{ path: "/emails/thread/message.md", metadataDocs: 1 }]);
	});
});
