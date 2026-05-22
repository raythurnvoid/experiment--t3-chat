import { R2 } from "@convex-dev/r2";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_INITIAL_CONTENT,
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "../server/files.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";

const r2Objects = new Map<string, Uint8Array>();

function r2_url(kind: "upload" | "object", key: string) {
	return `https://r2.test/${kind}/${encodeURIComponent(key)}`;
}

function key_from_r2_url(url: string) {
	return decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
}

function expected_asset_key(args: { workspaceId: string; projectId: string; assetId: string }) {
	return `workspaces/${args.workspaceId}/projects/${args.projectId}/assets/${args.assetId}`;
}

async function body_to_bytes(body: BodyInit | null | undefined) {
	if (body === null || body === undefined) {
		return new Uint8Array();
	}

	if (typeof body === "string") {
		return new TextEncoder().encode(body);
	}

	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body);
	}

	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}

	return new Uint8Array(await new Response(body).arrayBuffer());
}

function r2_text(key: string) {
	const bytes = r2Objects.get(key);
	return bytes ? new TextDecoder().decode(bytes) : null;
}

function array_buffer_from_bytes(bytes: Uint8Array) {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function bytes_to_response_body(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function stub_r2_and_modal_fetch(args: { markdown?: string; modalStatus?: number } = {}) {
	const { markdown = "# Converted\n\nPDF body", modalStatus = 200 } = args;

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("https://r2.test/upload/") && init?.method === "PUT") {
				r2Objects.set(key_from_r2_url(url), await body_to_bytes(init.body));
				return new Response(null, { status: 200 });
			}

			if (url.startsWith("https://r2.test/object/")) {
				const bytes = r2Objects.get(key_from_r2_url(url));
				return bytes ? new Response(bytes_to_response_body(bytes), { status: 200 }) : new Response(null, { status: 404 });
			}

			if (url === process.env.MODAL_FILE_CONVERTER_URL) {
				if (modalStatus !== 200) {
					return new Response("failed", { status: modalStatus });
				}

				return new Response(
					JSON.stringify({
						markdown,
						converter: "markitdown",
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			return new Response(null, { status: 404 });
		}),
	);
}

async function seed_billing_snapshot_for_user(ctx: MutationCtx, userId: Id<"users">) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	if (usageSnapshot) return;

	const polarProductId = "r2_test_free_product";
	const existingProduct = await ctx.runQuery(components.polar.lib.getProduct, { id: polarProductId });
	if (!existingProduct) {
		await ctx.runMutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "r2_test_org",
				name: billing_PRODUCTS.Free.name,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [
					{
						id: `${polarProductId}_price`,
						createdAt: "2026-01-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "free",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						recurringInterval: "month",
					},
				],
				medias: [],
				benefits: [],
			},
		});
	}

	await ctx.db.insert("billing_usage_snapshots", {
		userId,
		polarCustomerId: `r2_test_customer_${userId}`,
		subscription: {
			id: `r2_test_subscription_${userId}`,
			productId: polarProductId,
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		},
		meter: {
			id: "meter_press_usage",
			consumedUnits: 0,
			creditedUnits: 100_000,
			balance: 100_000,
			amountDueCents: 0,
		},
		lastSyncedAt: Date.now(),
	});
}

beforeEach(() => {
	r2Objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: r2_url("upload", customKey ?? "test-upload-key"),
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string) => r2_url("object", key));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_asset_refactor" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	stub_r2_and_modal_fetch();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("r2 asset content", () => {
	test("creates Markdown nodes with Markdown, Yjs, and version snapshot assets", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "README.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const docs = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!node?.assetId || !node.yjsSnapshotId) {
				throw new Error("Expected Markdown node to point to live assets");
			}
			const [markdownAsset, yjsSnapshot, updates, snapshots] = await Promise.all([
				ctx.db.get("files_r2_assets", node.assetId),
				ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId),
				ctx.db
					.query("files_yjs_updates")
					.withIndex("by_workspace_project_file_sequence", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", node._id),
					)
					.collect(),
				ctx.db
					.query("files_snapshots")
					.withIndex("by_workspace_project_file_archivedAt", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", node._id),
					)
					.collect(),
			]);
			const yjsAsset = yjsSnapshot ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
			const versionAsset = snapshots[0] ? await ctx.db.get("files_r2_assets", snapshots[0].assetId) : null;

			return { node, markdownAsset, yjsSnapshot, yjsAsset, updates, snapshots, versionAsset };
		});

		expect(docs.node.contentType).toBe("text/markdown;charset=utf-8");
		expect(docs.markdownAsset?.kind).toBe("content");
		expect(docs.markdownAsset?.r2Key).toBe(
			expected_asset_key({
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				assetId: docs.markdownAsset?._id ?? "",
			}),
		);
		expect(docs.markdownAsset?.r2Key ? r2_text(docs.markdownAsset.r2Key) : null).toBe(files_INITIAL_CONTENT);
		expect(docs.yjsSnapshot?.sequence).toBe(0);
		expect(docs.yjsAsset?.kind).toBe("yjs_snapshot");
		expect(docs.yjsAsset?.r2Key).toBe(
			expected_asset_key({
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				assetId: docs.yjsAsset?._id ?? "",
			}),
		);
		expect(docs.updates).toHaveLength(0);
		expect(docs.snapshots).toHaveLength(1);
		expect(docs.versionAsset?.kind).toBe("content_snapshot");
		expect(docs.versionAsset?.r2Key ? r2_text(docs.versionAsset.r2Key) : null).toBe(files_INITIAL_CONTENT);
	});

	test("reads latest saved Markdown from Yjs updates when materialization is stale", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, db.userId);
			return db;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "stale-read.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const assets = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!node?.assetId || !node.yjsSnapshotId) {
				throw new Error("Expected Markdown node assets");
			}
			const [asset, yjsSnapshotDoc] = await Promise.all([
				ctx.db.get("files_r2_assets", node.assetId),
				ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId),
			]);
			const yjsSnapshotAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			if (!asset?.r2Key || !yjsSnapshotAsset?.r2Key) {
				throw new Error("Expected Markdown and Yjs snapshot R2 keys");
			}

			return { markdownR2Key: asset.r2Key, yjsSnapshotR2Key: yjsSnapshotAsset.r2Key };
		});
		const baseSnapshotBytes = r2Objects.get(assets.yjsSnapshotR2Key);
		if (!baseSnapshotBytes) {
			throw new Error("Expected Yjs snapshot bytes in R2");
		}

		const updatedMarkdown = "# Stale read\n\nThis content only exists in Yjs updates.";
		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(baseSnapshotBytes));
		const nextYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(baseSnapshotBytes));
		const nextProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextYjsDoc,
			markdown: updatedMarkdown,
		});
		if (nextProjection._nay) {
			throw new Error(nextProjection._nay.message);
		}
		const diffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
			yjsBeforeDoc: baseYjsDoc,
			yjsDoc: nextProjection._yay,
		});
		baseYjsDoc.destroy();
		nextYjsDoc.destroy();
		if (!diffUpdate) {
			throw new Error("Expected a Yjs diff update");
		}

		const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId: created._yay.nodeId,
			update: files_u8_to_array_buffer(diffUpdate),
			sessionId: "stale-read-session",
		});
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}

		expect(r2_text(assets.markdownR2Key)).toBe(files_INITIAL_CONTENT);
		const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/stale-read.md",
		});

		expect(readResult?.content).toBe(updatedMarkdown);
		expect(readResult?.pendingUpdateId).toBeNull();
	});

	test("reads pending-update Markdown before saved R2 content", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "pending-read.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const pendingMarkdown = "# Pending edit\n\nThis content is still in the agent draft.";
		const upsertResult = await asUser.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: pendingMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingUpdate = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("userId", db.userId)
						.eq("nodeId", created._yay.nodeId),
				)
				.unique(),
		);
		if (!pendingUpdate) {
			throw new Error("Expected pending update");
		}
		const pendingYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.baseYjsUpdate, {
			additionalIncrementalArrayBufferUpdates: [pendingUpdate.unstagedBranchYjsUpdate],
		});
		const pendingRowMarkdown = files_yjs_doc_get_markdown({ yjsDoc: pendingYjsDoc });
		pendingYjsDoc.destroy();
		if (pendingRowMarkdown._nay) {
			throw new Error(pendingRowMarkdown._nay.message);
		}
		expect(pendingRowMarkdown._yay).toBe(pendingMarkdown);

		const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/pending-read.md",
			pendingUpdateId: pendingUpdate._id,
		});

		expect(readResult?.pendingUpdateId).toBe(pendingUpdate._id);
		expect(readResult?.content).toBe(pendingMarkdown);
	});

	test("reserves source uploads with asset-id R2 keys and no upload table", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "report.pdf",
			contentType: "application/pdf",
			size: 42,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const docs = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", created._yay.assetId);

			return { node, asset };
		});

		expect(docs.node?.assetId).toBe(created._yay.assetId);
		expect(docs.node?.contentType).toBe("application/pdf");
		expect(docs.asset?.kind).toBe("upload");
		expect(docs.asset?.r2Key).toBeUndefined();
		expect(created._yay.url).toContain(
			encodeURIComponent(
				expected_asset_key({
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					assetId: created._yay.assetId,
				}),
			),
		);
		const signedDownload = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: created._yay.nodeId,
		});
		expect(signedDownload._nay).toMatchObject({ message: "Not found" });
	});

	test("R2 events confirm upload assets and conversion creates a shadow Markdown node", async () => {
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
			filename: "event.pdf",
			contentType: "application/pdf",
			size: 4096,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const sourceAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!sourceAsset) {
			throw new Error("Expected upload asset");
		}
		const sourceAssetR2Key = expected_asset_key({
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			assetId: sourceAsset._id,
		});

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_1",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 4096,
						eTag: "etag_1",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const uploadedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(uploadedAsset?.r2Key).toBe(sourceAssetR2Key);
		expect(uploadedAsset?.etag).toBe("etag_1");
		expect(uploadedAsset?.conversionWorkId).toBe("work_asset_refactor");

		const signedDownload = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(signedDownload._yay?.url).toContain(encodeURIComponent(sourceAssetR2Key));

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const shadowNode = sourceNode?.shadowFileNodeIds[0]
				? await ctx.db.get("files_nodes", sourceNode.shadowFileNodeIds[0])
				: null;
			const shadowAsset = shadowNode?.assetId ? await ctx.db.get("files_r2_assets", shadowNode.assetId) : null;
			const nextSourceAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);

			return { sourceNode, shadowNode, shadowAsset, nextSourceAsset };
		});

		expect(docs.sourceNode?.shadowFileNodeIds).toHaveLength(1);
		expect(docs.shadowNode?.shadowSourceFileNodeId).toBe(upload._yay.nodeId);
		expect(docs.shadowNode?.contentType).toBe("text/markdown;charset=utf-8");
		expect(docs.shadowAsset?.kind).toBe("content");
		expect(docs.shadowAsset?.r2Key ? r2_text(docs.shadowAsset.r2Key) : null).toBe("# Converted\n\nPDF body");
		expect(docs.nextSourceAsset?.conversionWorkId).toBeUndefined();
	});

	test("archives an active shadow-path occupant before creating the conversion shadow", async () => {
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
		await t.run(async (ctx) =>
			ctx.db.patch("files_r2_assets", upload._yay.assetId, {
				r2Key: expected_asset_key({
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					assetId: upload._yay.assetId,
				}),
				updatedAt: Date.now(),
			}),
		);

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const oldShadow = await ctx.db.get("files_nodes", existingShadowId);
			const newShadowId = source?.shadowFileNodeIds[0];
			const newShadow = newShadowId ? await ctx.db.get("files_nodes", newShadowId) : null;
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
			return { source, oldShadow, newShadow, activeShadowAtPath };
		});

		expect(docs.oldShadow?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.newShadow?._id).not.toBe(existingShadowId);
		expect(docs.newShadow).toMatchObject({
			name: "collision.pdf.shadow.md",
			shadowSourceFileNodeId: upload._yay.nodeId,
			contentType: "text/markdown;charset=utf-8",
		});
		expect(docs.newShadow?.archiveOperationId).toBeUndefined();
		expect(docs.activeShadowAtPath?._id).toBe(docs.newShadow?._id);
		expect(docs.source?.shadowFileNodeIds).toContain(docs.newShadow?._id);
	});

	test("keeps conversion work reserved when Modal conversion fails", async () => {
		stub_r2_and_modal_fetch({ modalStatus: 500 });

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
			filename: "broken.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run(async (ctx) =>
			ctx.db.patch("files_r2_assets", upload._yay.assetId, {
				r2Key: expected_asset_key({
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					assetId: upload._yay.assetId,
				}),
				conversionWorkId: "work_asset_refactor" as WorkId,
				updatedAt: Date.now(),
			}),
		);

		await expect(
			asUser.action(internal.r2.convert_upload_to_markdown, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceAssetId: upload._yay.assetId,
			}),
		).rejects.toThrow("Failed to convert uploaded file");

		const docs = await t.run(async (ctx) => {
			const [source, sourceAsset] = await Promise.all([
				ctx.db.get("files_nodes", upload._yay.nodeId),
				ctx.db.get("files_r2_assets", upload._yay.assetId),
			]);

			return { source, sourceAsset };
		});
		expect(docs.source?.shadowFileNodeIds).toEqual([]);
		expect(docs.sourceAsset?.conversionWorkId).toBe("work_asset_refactor");
	});

	test("creates an archived shadow when the source is archived before conversion", async () => {
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
			filename: "archived.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run(async (ctx) => {
			await Promise.all([
				ctx.db.patch("files_nodes", upload._yay.nodeId, {
					archiveOperationId: "archive_conversion_test",
					updatedBy: db.userId,
					updatedAt: Date.now(),
				}),
				ctx.db.patch("files_r2_assets", upload._yay.assetId, {
					r2Key: expected_asset_key({
						workspaceId: db.workspaceId,
						projectId: db.projectId,
						assetId: upload._yay.assetId,
					}),
					updatedAt: Date.now(),
				}),
			]);
		});

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const shadowId = source?.shadowFileNodeIds[0];
			const shadow = shadowId ? await ctx.db.get("files_nodes", shadowId) : null;
			return { source, shadow };
		});
		expect(docs.source?.archiveOperationId).toBe("archive_conversion_test");
		expect(docs.shadow?.shadowSourceFileNodeId).toBe(upload._yay.nodeId);
		expect(docs.shadow?.archiveOperationId).toBe("archive_conversion_test");
	});

	test("reads converted content through the source path and searches the shadow path", async () => {
		stub_r2_and_modal_fetch({ markdown: "# Converted\n\nPDF body searchable" });

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
			filename: "readable.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run(async (ctx) =>
			ctx.db.patch("files_r2_assets", upload._yay.assetId, {
				r2Key: expected_asset_key({
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					assetId: upload._yay.assetId,
				}),
				updatedAt: Date.now(),
			}),
		);

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
		});

		const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/readable.pdf",
		});
		if (!readResult) {
			throw new Error("Expected readable.pdf to resolve converted Markdown");
		}
		expect(readResult.content).toContain("PDF body searchable");
		expect(readResult.displayNodeId).toBe(upload._yay.nodeId);
		expect(readResult.nodeId).not.toBe(upload._yay.nodeId);

		const searchResult = await asUser.query(internal.files_nodes.text_search_files, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			query: "PDF body",
			limit: 10,
		});
		expect(searchResult.items.map((item) => item.path)).toContain("/readable.pdf.shadow.md");
		expect(searchResult.items.map((item) => item.path)).not.toContain("/readable.pdf");
	});
});
