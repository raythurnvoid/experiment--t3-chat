import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_INITIAL_CONTENT,
	files_MAX_TEXT_CONTENT_BYTES,
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

vi.mock("ai", () => ({
	generateText: vi.fn(async (args: { messages?: unknown }) => {
		const prompt = JSON.stringify(args.messages);
		return {
			text: prompt.includes("Summarize the uploaded video") ? "Video summary body" : "Image description body",
			totalUsage: {
				inputTokens: 100,
				outputTokens: 20,
			},
		};
	}),
	smoothStream: vi.fn(() => undefined),
	streamText: vi.fn(() => ({
		toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
	})),
}));

const r2Objects = new Map<string, Uint8Array>();
let enqueueActionSpy: MockInstance;

function r2_url(kind: "upload" | "object", key: string) {
	return `https://r2.test/${kind}/${encodeURIComponent(key)}`;
}

function key_from_r2_url(url: string) {
	return decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
}

function expected_asset_key(args: { workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects">; assetId: string }) {
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

function stub_r2_and_modal_fetch(
	args: {
		markdown?: string;
		modalStatus?: number;
		mediaTransformerAlwaysFails?: boolean;
		transcriptionText?: string;
		onModalRequest?: (body: Record<string, unknown>) => void;
	} = {},
) {
	const {
		markdown = "# Converted\n\nPDF body",
		modalStatus = 200,
		mediaTransformerAlwaysFails = false,
		transcriptionText = "Transcript segment body",
		onModalRequest,
	} = args;

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
				return bytes
					? new Response(bytes_to_response_body(bytes), { status: 200 })
					: new Response(null, { status: 404 });
			}

			if (url === process.env.MODAL_FILE_CONVERTER_URL) {
				onModalRequest?.(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
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

			if (url === `${process.env.CLOUDFLARE_MEDIA_TRANSFORMER_URL}/api/media/frame`) {
				if (mediaTransformerAlwaysFails) {
					return new Response(null, { status: 422 });
				}

				const body = JSON.parse(String(init?.body ?? "{}")) as { timeSeconds?: number };
				if ((body.timeSeconds ?? 0) > 5) {
					return new Response(null, { status: 422 });
				}

				return new Response(new Uint8Array([255, 216, 255]), {
					status: 200,
					headers: { "Content-Type": "image/jpeg" },
				});
			}

			if (url === `${process.env.CLOUDFLARE_MEDIA_TRANSFORMER_URL}/api/media/audio-segment`) {
				if (mediaTransformerAlwaysFails) {
					return new Response(null, { status: 422 });
				}

				const body = JSON.parse(String(init?.body ?? "{}")) as { startSeconds?: number };
				if ((body.startSeconds ?? 0) > 0) {
					return new Response(null, { status: 422 });
				}

				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "Content-Type": "audio/mp4" },
				});
			}

			if (url === "https://api.openai.com/v1/audio/transcriptions") {
				return new Response(
					JSON.stringify({
						text: transcriptionText,
						usage: {
							input_tokens: 10,
							output_tokens: 5,
						},
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

async function get_active_file_node_by_path(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		path: string;
	},
) {
	return await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_path_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.unique();
}

async function get_pdf_output_node(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		sourceName: string;
	},
) {
	const convertedMarkdown = await get_active_file_node_by_path(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: `/${args.sourceName}.md`,
	});
	if (!convertedMarkdown) {
		throw new Error("Expected PDF generated output node");
	}
	if (!convertedMarkdown.assetId) {
		throw new Error("Expected PDF generated output asset");
	}

	return {
		convertedMarkdown: {
			...convertedMarkdown,
			assetId: convertedMarkdown.assetId,
		},
	};
}

beforeEach(() => {
	r2Objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: r2_url("upload", customKey ?? "test-upload-key"),
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string) => r2_url("object", key));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_asset_refactor" as never);
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
			path: "README.md",
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
					.withIndex("by_workspace_project_fileNode_sequence", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("fileNodeId", node._id),
					)
					.collect(),
				ctx.db
					.query("files_snapshots")
					.withIndex("by_workspace_project_fileNode_archivedAt", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("fileNodeId", node._id),
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
			path: "stale-read.md",
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
			path: "pending-read.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const pendingMarkdown = "# Pending edit\n\nThis content is still in the agent draft.";
		const upsertResult = await asUser.action(
			internal.files_pending_updates.upsert_file_pending_update_internal_action,
			{
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: db.userId,
				nodeId: created._yay.nodeId,
				unstagedMarkdown: pendingMarkdown,
			},
		);
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingUpdate = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_fileNode", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("userId", db.userId)
						.eq("fileNodeId", created._yay.nodeId),
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

	test("R2 events create a visible generated PDF output and conversion finalizes it by node id", async () => {
		const modalRequests: Record<string, unknown>[] = [];
		stub_r2_and_modal_fetch({ onModalRequest: (body) => modalRequests.push(body) });

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
		const pendingDocs = await t.run(async (ctx) => {
			const outputs = await get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "event.pdf",
			});
			const convertedAsset = outputs.convertedMarkdown.assetId
				? await ctx.db.get("files_r2_assets", outputs.convertedMarkdown.assetId)
				: null;
			const testOutput = await get_active_file_node_by_path(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				path: "/event.pdf.test.md",
			});

			return { outputs, convertedAsset, testOutput };
		});
		expect(pendingDocs.outputs.convertedMarkdown.name).toBe("event.pdf.md");
		expect(pendingDocs.outputs.convertedMarkdown.contentType).toBe("text/markdown;charset=utf-8");
		expect(pendingDocs.outputs.convertedMarkdown.yjsSnapshotId).toBeUndefined();
		expect(pendingDocs.convertedAsset?.kind).toBe("content");
		expect(pendingDocs.convertedAsset?.conversionWorkId).toBe("work_asset_refactor");
		expect(pendingDocs.testOutput).toBeNull();

		const signedDownload = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(signedDownload._yay?.url).toContain(encodeURIComponent(sourceAssetR2Key));

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			outputAssetId: pendingDocs.outputs.convertedMarkdown.assetId,
		});
		expect(modalRequests).toHaveLength(1);
		expect(modalRequests[0]).toMatchObject({ maxMarkdownBytes: files_MAX_TEXT_CONTENT_BYTES });
		expect(modalRequests[0]).not.toHaveProperty("maxMarkdownCharacters");

		const docs = await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const outputs = await get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "event.pdf",
			});
			const outputNode = outputs.convertedMarkdown;
			const outputAsset = outputNode.assetId ? await ctx.db.get("files_r2_assets", outputNode.assetId) : null;
			const nextSourceAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);

			return { sourceNode, outputNode, outputAsset, nextSourceAsset };
		});

		expect(docs.sourceNode?.assetId).toBe(upload._yay.assetId);
		expect(docs.outputNode).toMatchObject({
			name: "event.pdf.md",
			contentType: "text/markdown;charset=utf-8",
			yjsSnapshotId: expect.any(String),
		});
		expect(docs.outputAsset?.kind).toBe("content");
		expect(docs.outputAsset?.r2Key ? r2_text(docs.outputAsset.r2Key) : null).toBe("# Converted\n\nPDF body");
		expect(docs.nextSourceAsset?.conversionWorkId).toBeNull();

		enqueueActionSpy.mockClear();

		const duplicateResponse = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_2",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 4096,
						eTag: "etag_2",
					},
					eventTime: "2026-05-11T00:01:00.000Z",
				},
			}),
		});
		expect(duplicateResponse.status).toBe(204);
		expect(enqueueActionSpy).not.toHaveBeenCalled();

		const duplicateAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(duplicateAsset?.etag).toBe("etag_2");
		expect(duplicateAsset?.conversionWorkId).toBeNull();
	});

	test("R2 events create and finalize an image description Markdown sibling", async () => {
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

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "photo.png",
			contentType: "image/png",
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
				cloudflareMessageId: "message_image",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 4096,
						eTag: "etag_image",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const pendingOutput = await t.run(async (ctx) => {
			const output = await get_active_file_node_by_path(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				path: "/photo.png.description.md",
			});
			if (!output?.assetId) {
				throw new Error("Expected generated image description node");
			}

			return {
				output: { ...output, assetId: output.assetId },
				asset: await ctx.db.get("files_r2_assets", output.assetId),
			};
		});
		expect(pendingOutput.output.yjsSnapshotId).toBeUndefined();
		expect(pendingOutput.asset?.conversionWorkId).toBe("work_asset_refactor");

		await asUser.action(internal.r2.describe_image_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			outputAssetId: pendingOutput.output.assetId,
		});

		const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/photo.png.description.md",
		});
		expect(readResult?.content).toContain("Image description body");
		const processedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(processedAsset?.conversionWorkId).toBeNull();
	});

	test("R2 events create and finalize video summary and transcript Markdown siblings", async () => {
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

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "clip.mp4",
			contentType: "video/mp4",
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
				cloudflareMessageId: "message_video",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 4096,
						eTag: "etag_video",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const pendingOutputs = await t.run(async (ctx) => {
			const [summary, transcript] = await Promise.all([
				get_active_file_node_by_path(ctx, {
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					path: "/clip.mp4.summary.md",
				}),
				get_active_file_node_by_path(ctx, {
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					path: "/clip.mp4.transcript.md",
				}),
			]);
			if (!summary?.assetId || !transcript?.assetId) {
				throw new Error("Expected generated video output nodes");
			}

			return {
				summary: { ...summary, assetId: summary.assetId },
				transcript: { ...transcript, assetId: transcript.assetId },
			};
		});

		await asUser.action(internal.r2.summarize_video_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			summaryOutputAssetId: pendingOutputs.summary.assetId,
			transcriptOutputAssetId: pendingOutputs.transcript.assetId,
		});

		const [summaryReadResult, transcriptReadResult] = await Promise.all([
			asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: db.userId,
				path: "/clip.mp4.summary.md",
			}),
			asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: db.userId,
				path: "/clip.mp4.transcript.md",
			}),
		]);
		expect(summaryReadResult?.content).toContain("Video summary body");
		expect(transcriptReadResult?.content).toContain("Transcript segment body");
		const processedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(processedAsset?.conversionWorkId).toBeNull();
	});

	test("falls back to original video transcription when media transformation rejects the upload", async () => {
		stub_r2_and_modal_fetch({
			mediaTransformerAlwaysFails: true,
			transcriptionText: "Direct video transcript body",
		});

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

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "long-clip.mp4",
			contentType: "video/mp4",
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
		r2Objects.set(sourceAssetR2Key, new Uint8Array([1, 2, 3, 4]));

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_long_video",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 4096,
						eTag: "etag_long_video",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const pendingOutputs = await t.run(async (ctx) => {
			const [summary, transcript] = await Promise.all([
				get_active_file_node_by_path(ctx, {
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					path: "/long-clip.mp4.summary.md",
				}),
				get_active_file_node_by_path(ctx, {
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					path: "/long-clip.mp4.transcript.md",
				}),
			]);
			if (!summary?.assetId || !transcript?.assetId) {
				throw new Error("Expected generated video output nodes");
			}

			return {
				summary: { ...summary, assetId: summary.assetId },
				transcript: { ...transcript, assetId: transcript.assetId },
			};
		});

		await asUser.action(internal.r2.summarize_video_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			summaryOutputAssetId: pendingOutputs.summary.assetId,
			transcriptOutputAssetId: pendingOutputs.transcript.assetId,
		});

		const [summaryReadResult, transcriptReadResult] = await Promise.all([
			asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: db.userId,
				path: "/long-clip.mp4.summary.md",
			}),
			asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: db.userId,
				path: "/long-clip.mp4.transcript.md",
			}),
		]);
		expect(summaryReadResult?.content).toContain("Video summary body");
		expect(transcriptReadResult?.content).toContain("Direct video transcript body");
		const processedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(processedAsset?.conversionWorkId).toBeNull();
	});

	test("finalizes uploaded Markdown into editable content and marks the upload terminal", async () => {
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
			filename: "uploaded.md",
			contentType: "text/markdown;charset=utf-8",
			size: 1024,
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
		const markdownContent = "# Uploaded\n\nMarkdown body";
		r2Objects.set(sourceAssetR2Key, new TextEncoder().encode(markdownContent));

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_markdown",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: "etag_markdown",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const uploadedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(uploadedAsset?.conversionWorkId).toBe("work_asset_refactor");

		await asUser.action(internal.r2.finalize_uploaded_markdown_file, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const sourceAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const contentAsset = sourceNode?.assetId ? await ctx.db.get("files_r2_assets", sourceNode.assetId) : null;

			return { sourceNode, sourceAsset, contentAsset };
		});

		expect(docs.sourceNode?.assetId).not.toBe(upload._yay.assetId);
		expect(docs.sourceNode?.contentType).toBe("text/markdown;charset=utf-8");
		expect(docs.sourceNode?.yjsSnapshotId).toEqual(expect.any(String));
		expect(docs.sourceNode?.yjsLastSequenceId).toEqual(expect.any(String));
		expect(docs.contentAsset?.kind).toBe("content");
		expect(docs.contentAsset?.r2Key ? r2_text(docs.contentAsset.r2Key) : null).toBe(markdownContent);
		expect(docs.sourceAsset?.conversionWorkId).toBeNull();
	});

	test("R2 events do not infer PDF conversion from the filename", async () => {
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
			filename: "not-a-pdf.pdf",
			contentType: "application/octet-stream",
			size: 1024,
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
		enqueueActionSpy.mockClear();

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_not_pdf",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: "etag_not_pdf",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const docs = await t.run(async (ctx) => {
			const nextSourceAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const generated = await get_active_file_node_by_path(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				path: "/not-a-pdf.pdf.md",
			});
			return { nextSourceAsset, generated };
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
		expect(docs.nextSourceAsset?.conversionWorkId).toBeNull();
		expect(docs.generated).toBeNull();
	});

	test.each([413, 422])("marks Modal %s conversion responses terminal on the generated output", async (modalStatus) => {
		stub_r2_and_modal_fetch({ modalStatus });

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
			filename: "modal-limit.pdf",
			contentType: "application/pdf",
			size: 1024,
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
				cloudflareMessageId: `message_modal_${modalStatus}`,
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: `etag_modal_${modalStatus}`,
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);
		const outputs = await t.run(async (ctx) =>
			get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "modal-limit.pdf",
			}),
		);

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			outputAssetId: outputs.convertedMarkdown.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const nextSourceAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const convertedAsset = outputs.convertedMarkdown.assetId
				? await ctx.db.get("files_r2_assets", outputs.convertedMarkdown.assetId)
				: null;

			return { sourceNode, nextSourceAsset, convertedAsset };
		});

		expect(docs.sourceNode?.assetId).toBe(upload._yay.assetId);
		expect(docs.nextSourceAsset?.conversionWorkId).toBeNull();
		expect(docs.convertedAsset?.conversionWorkId).toBeNull();
	});

	test("marks oversized converted Markdown terminal by UTF-8 byte size", async () => {
		const oversizedMarkdown = "é".repeat(Math.floor(files_MAX_TEXT_CONTENT_BYTES / 2) + 1);
		expect(oversizedMarkdown.length).toBeLessThanOrEqual(files_MAX_TEXT_CONTENT_BYTES);
		stub_r2_and_modal_fetch({ markdown: oversizedMarkdown });

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
			filename: "modal-byte-limit.pdf",
			contentType: "application/pdf",
			size: 1024,
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
				cloudflareMessageId: "message_modal_byte_limit",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: "etag_modal_byte_limit",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);
		const outputs = await t.run(async (ctx) =>
			get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "modal-byte-limit.pdf",
			}),
		);

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			outputAssetId: outputs.convertedMarkdown.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const nextSourceAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const convertedAsset = outputs.convertedMarkdown.assetId
				? await ctx.db.get("files_r2_assets", outputs.convertedMarkdown.assetId)
				: null;

			return { nextSourceAsset, convertedAsset };
		});

		expect(docs.nextSourceAsset?.conversionWorkId).toBeNull();
		expect(docs.convertedAsset?.conversionWorkId).toBeNull();
		expect(docs.convertedAsset?.r2Key).toBeUndefined();
	});

	test("archives active generated output name conflicts before creating placeholders", async () => {
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
		const existingGeneratedId = await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "collision.pdf.md",
				kind: "file",
				path: "/collision.pdf.md",
				treePath: "/collision.pdf.md",
			}),
		);
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
				cloudflareMessageId: "message_collision",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 4096,
						eTag: "etag_collision",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const docs = await t.run(async (ctx) => {
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const oldGenerated = await ctx.db.get("files_nodes", existingGeneratedId);
			const outputs = await get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "collision.pdf",
			});
			const activeGeneratedAtPath = await get_active_file_node_by_path(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				path: "/collision.pdf.md",
			});
			return { source, oldGenerated, outputs, activeGeneratedAtPath };
		});

		expect(docs.oldGenerated?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.source?.assetId).toBe(upload._yay.assetId);
		expect(docs.outputs.convertedMarkdown.name).toBe("collision.pdf.md");
		expect(docs.outputs.convertedMarkdown._id).not.toBe(existingGeneratedId);
		expect(docs.outputs.convertedMarkdown).toMatchObject({
			name: "collision.pdf.md",
			contentType: "text/markdown;charset=utf-8",
		});
		expect(docs.outputs.convertedMarkdown.archiveOperationId).toBeUndefined();
		expect(docs.activeGeneratedAtPath?._id).toBe(docs.outputs.convertedMarkdown._id);
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
				cloudflareMessageId: "message_broken",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: "etag_broken",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);
		const outputs = await t.run(async (ctx) =>
			get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "broken.pdf",
			}),
		);

		await expect(
			asUser.action(internal.r2.convert_upload_to_markdown, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceAssetId: upload._yay.assetId,
				outputAssetId: outputs.convertedMarkdown.assetId,
			}),
		).rejects.toThrow("Failed to convert uploaded file");

		const docs = await t.run(async (ctx) => {
			const [source, sourceAsset, convertedAsset] = await Promise.all([
				ctx.db.get("files_nodes", upload._yay.nodeId),
				ctx.db.get("files_r2_assets", upload._yay.assetId),
				outputs.convertedMarkdown.assetId ? ctx.db.get("files_r2_assets", outputs.convertedMarkdown.assetId) : null,
			]);

			return { source, sourceAsset, convertedAsset };
		});
		expect(docs.source?.assetId).toBe(upload._yay.assetId);
		expect(docs.sourceAsset?.conversionWorkId).toBe("work_asset_refactor");
		expect(docs.convertedAsset?.conversionWorkId).toBe("work_asset_refactor");
	});

	test("finalizes generated output node ids after they move", async () => {
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
			filename: "moved.pdf",
			contentType: "application/pdf",
			size: 1024,
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
				cloudflareMessageId: "message_moved",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: "etag_moved",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);
		const outputs = await t.run(async (ctx) =>
			get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "moved.pdf",
			}),
		);
		await t.run(async (ctx) => {
			const folderId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "processed",
				kind: "folder",
				path: "/processed",
				treePath: "/processed/",
			});
			await ctx.db.patch("files_nodes", outputs.convertedMarkdown._id, {
				parentId: folderId,
				path: "/processed/moved.pdf.md",
				updatedBy: db.userId,
				updatedAt: Date.now(),
			});
		});

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			outputAssetId: outputs.convertedMarkdown.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const [source, movedOutput] = await Promise.all([
				ctx.db.get("files_nodes", upload._yay.nodeId),
				ctx.db.get("files_nodes", outputs.convertedMarkdown._id),
			]);
			const movedAsset = movedOutput?.assetId ? await ctx.db.get("files_r2_assets", movedOutput.assetId) : null;
			const oldRootOutput = await get_active_file_node_by_path(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				path: "/moved.pdf.md",
			});
			return { source, movedOutput, movedAsset, oldRootOutput };
		});
		expect(docs.source?.path).toBe("/moved.pdf");
		expect(docs.movedOutput).toMatchObject({
			_id: outputs.convertedMarkdown._id,
			path: "/processed/moved.pdf.md",
			contentType: "text/markdown;charset=utf-8",
			yjsSnapshotId: expect.any(String),
		});
		expect(docs.movedAsset?.r2Key ? r2_text(docs.movedAsset.r2Key) : null).toBe("# Converted\n\nPDF body");
		expect(docs.oldRootOutput).toBeNull();
	});

	test("reads and searches generated PDF Markdown through its visible sibling path", async () => {
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
				cloudflareMessageId: "message_readable",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: sourceAsset.r2Bucket,
					object: {
						key: sourceAssetR2Key,
						size: 1024,
						eTag: "etag_readable",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);
		const outputs = await t.run(async (ctx) =>
			get_pdf_output_node(ctx, {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				sourceName: "readable.pdf",
			}),
		);

		await asUser.action(internal.r2.convert_upload_to_markdown, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			sourceAssetId: upload._yay.assetId,
			outputAssetId: outputs.convertedMarkdown.assetId,
		});

		const sourceReadResult = await asUser.action(
			internal.files_nodes.get_file_last_available_markdown_content_by_path,
			{
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				userId: db.userId,
				path: "/readable.pdf",
			},
		);
		expect(sourceReadResult).toBeNull();

		const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/readable.pdf.md",
		});
		if (!readResult) {
			throw new Error("Expected readable.pdf.md to resolve converted Markdown");
		}
		expect(readResult.content).toContain("PDF body searchable");
		expect(readResult.displayNodeId).toBe(outputs.convertedMarkdown._id);
		expect(readResult.nodeId).toBe(outputs.convertedMarkdown._id);

		const searchResult = await asUser.query(internal.files_nodes.text_search_files, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			query: "PDF body",
			numItems: 10,
			cursor: null,
		});
		expect(searchResult.items.map((item) => item.path)).toContain("/readable.pdf.md");
		expect(searchResult.items.map((item) => item.path)).not.toContain("/readable.pdf");
	});
});
