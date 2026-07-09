import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
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

function expected_asset_key(args: {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	assetId: string;
}) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${args.assetId}`;
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
		onModalRequest?: (body: Record<string, unknown>) => void;
		onPluginRunnerRequest?: (body: Record<string, unknown>) => Response | Promise<Response>;
	} = {},
) {
	const {
		markdown = "# Converted\n\nPDF body",
		modalStatus = 200,
		mediaTransformerAlwaysFails = false,
		onModalRequest,
		onPluginRunnerRequest,
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

			if (url === `${process.env.PLUGIN_RUNNER_URL}/internal/plugin-runner/run`) {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return (
					(await onPluginRunnerRequest?.(body)) ??
					new Response(JSON.stringify({ status: "succeeded" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
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

async function install_upload_plugin(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		name: "image" | "video" | "pdf";
		displayName: string;
		description: string;
		contentTypes: string[];
	},
) {
	const registered = await t.action(internal.plugins.register_plugin_version, {
		name: args.name,
		displayName: args.displayName,
		version: "0.1.0",
		description: args.description,
		reviewStatus: "passed",
		artifactHash: `sha256:${"a".repeat(64)}`,
		sourceRepositoryUrl: `https://github.com/bonobo/${args.name}-plugin`,
		sourceOwner: "bonobo",
		sourceRepo: `${args.name}-plugin`,
		sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: `plugins/${args.name}/manifest.json`,
		backendEntrypointFile: {
			entry: "dist/backend/worker.js",
			moduleName: "plugin.js",
			r2Key: `plugins/${args.name}/backend/worker.js`,
			sha256: `sha256:${"b".repeat(64)}`,
			compatibilityDate: "2026-07-01",
			compatibilityFlags: ["nodejs_compat"],
		},
		events: [{ type: "files.upload.completed", contentTypes: args.contentTypes }],
		capabilities: ["plugin.secrets.read", "outbound.fetch"],
		outboundOrigins: [],
		files: [
			{
				path: "dist/backend/worker.js",
				sha256: `sha256:${"b".repeat(64)}`,
				bytes: 128,
				contentType: "application/javascript",
				r2Key: `plugins/${args.name}/backend/worker.js`,
			},
		],
		createdBy: args.userId,
		sourceFiles: [{ path: "dist/backend/worker.js", rawText: "export default { fetch: () => new Response('ok') };" }],
	});
	if (registered._nay) {
		throw new Error(registered._nay.message);
	}

	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: args.userId,
		name: "Test User",
	});
	const installed = await asUser.mutation(api.plugins.install_version, {
		membershipId: args.membershipId,
		pluginVersionId: registered._yay.pluginVersionId,
		acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
		acceptedOutboundOrigins: [],
	});
	if (installed._nay) {
		throw new Error(installed._nay.message);
	}
	return installed._yay.installationId;
}

async function get_active_file_node_by_path(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		path: string;
	},
) {
	return await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.unique();
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
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id),
					)
					.collect(),
				ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id),
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: docs.markdownAsset?._id ?? "",
			}),
		);
		expect(docs.markdownAsset?.r2Key ? r2_text(docs.markdownAsset.r2Key) : null).toBe(files_INITIAL_CONTENT);
		expect(docs.yjsSnapshot?.sequence).toBe(0);
		expect(docs.yjsAsset?.kind).toBe("yjs_snapshot");
		expect(docs.yjsAsset?.r2Key).toBe(
			expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
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
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
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

	test("R2 events run the PDF plugin and write a generated Markdown sibling", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "pdf",
			displayName: "PDF",
			description: "PDF markdown generation",
			contentTypes: ["application/pdf"],
		});
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
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!asset) {
			throw new Error("Expected upload asset");
		}
		const assetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset._id,
		});
		const pluginRunnerRequests: Record<string, unknown>[] = [];
		stub_r2_and_modal_fetch({
			onPluginRunnerRequest: async (body) => {
				pluginRunnerRequests.push(body);
				const host = body.host as { token: string };
				const sourceUrlResponse = await t.fetch("/api/plugins/v1/source-temporary-url", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						pluginRunId: body.pluginRunId,
						expiresInSeconds: 60,
					}),
				});
				expect(sourceUrlResponse.status).toBe(200);
				expect(((await sourceUrlResponse.json()) as { url: string }).url).toContain(
					encodeURIComponent(assetR2Key),
				);

				const writeResponse = await t.fetch("/api/plugins/v1/write-markdown", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						pluginRunId: body.pluginRunId,
						path: "event.pdf.md",
						markdown: "# Plugin PDF extraction\n\nPLUGIN_PDF_E2E_2026",
					}),
				});
				expect(writeResponse.status).toBe(200);
				return new Response(JSON.stringify({ status: "succeeded" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 4096,
						eTag: "etag_1",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const uploadedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(uploadedAsset?.r2Key).toBe(assetR2Key);
		expect(uploadedAsset?.etag).toBe("etag_1");
		expect(uploadedAsset?.processingWorkId).toBeNull();
		const pendingOutput = await t.run(async (ctx) =>
			get_active_file_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: "/event.pdf.md",
			}),
		);
		expect(pendingOutput).toBeNull();

		const signedDownload = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: upload._yay.nodeId,
		});
		expect(signedDownload._yay?.url).toContain(encodeURIComponent(assetR2Key));

		const pluginRun = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique(),
		);
		if (!pluginRun) {
			throw new Error("Expected plugin event run");
		}
		expect(pluginRun.outputAssetId).toBeUndefined();
		expect(pluginRun.status).toBe("queued");

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const outputNode = await get_active_file_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: "/event.pdf.md",
			});
			const outputAsset = outputNode?.assetId ? await ctx.db.get("files_r2_assets", outputNode.assetId) : null;
			const nextAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);

			return { fileNode, outputNode, outputAsset, nextAsset };
		});

		expect(docs.fileNode?.assetId).toBe(upload._yay.assetId);
		expect(docs.outputNode).toMatchObject({
			name: "event.pdf.md",
			contentType: "text/markdown;charset=utf-8",
			yjsSnapshotId: expect.any(String),
		});
		expect(docs.outputAsset?.kind).toBe("content");
		expect(docs.outputAsset?.r2Key ? r2_text(docs.outputAsset.r2Key) : null).toContain("PLUGIN_PDF_E2E_2026");
		expect(docs.nextAsset?.processingWorkId).toBeNull();
		expect(pluginRunnerRequests).toHaveLength(1);
		expect(pluginRunnerRequests[0]).toMatchObject({
			pluginName: "pdf",
			pluginVersion: "0.1.0",
			artifactKey: "plugins/pdf/backend/worker.js",
			artifactHash: `sha256:${"b".repeat(64)}`,
			input: {
				event: "files.upload.completed",
				source: {
					name: "event.pdf",
					contentType: "application/pdf",
				},
			},
		});
		const completedRun = await t.run(async (ctx) => ctx.db.get("plugins_event_runs", pluginRun._id));
		expect(completedRun).toMatchObject({ status: "succeeded", hostWriteCount: 1 });

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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
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
		expect(duplicateAsset?.processingWorkId).toBeNull();
	});

	test("R2 events create and finalize an image description Markdown sibling", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, db.userId);
			return db;
		});
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "image",
			displayName: "Image",
			description: "Image markdown generation",
			contentTypes: ["image/png"],
		});
		const pluginRunnerRequests: Record<string, unknown>[] = [];
		stub_r2_and_modal_fetch({
			onPluginRunnerRequest: async (body) => {
				pluginRunnerRequests.push(body);
				const host = body.host as { token: string };
				const writeResponse = await t.fetch("/api/plugins/v1/write-markdown", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						pluginRunId: body.pluginRunId,
						path: "photo.png.description.md",
						markdown: "# Plugin image description\n\nPLUGIN_IMAGE_E2E_2026",
					}),
				});
				expect(writeResponse.status).toBe(200);
				return new Response(JSON.stringify({ status: "succeeded" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
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
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!asset) {
			throw new Error("Expected upload asset");
		}
		const assetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset._id,
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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 4096,
						eTag: "etag_image",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const pendingOutput = await t.run(async (ctx) =>
			get_active_file_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: "/photo.png.description.md",
			}),
		);
		expect(pendingOutput).toBeNull();

		const pluginRun = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique(),
		);
		if (!pluginRun) {
			throw new Error("Expected plugin event run");
		}
		expect(pluginRun.outputAssetId).toBeUndefined();
		expect(pluginRun.status).toBe("queued");

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/photo.png.description.md",
		});
		expect(readResult?.content).toContain("PLUGIN_IMAGE_E2E_2026");
		expect(pluginRunnerRequests).toHaveLength(1);
		expect(pluginRunnerRequests[0]).toMatchObject({
			pluginName: "image",
			pluginVersion: "0.1.0",
			artifactKey: "plugins/image/backend/worker.js",
			artifactHash: `sha256:${"b".repeat(64)}`,
			input: {
				event: "files.upload.completed",
				source: {
					name: "photo.png",
					contentType: "image/png",
				},
			},
		});
		const processedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(processedAsset?.processingWorkId).toBeNull();
		const completedRun = await t.run(async (ctx) => ctx.db.get("plugins_event_runs", pluginRun._id));
		expect(completedRun).toMatchObject({ status: "succeeded", hostWriteCount: 1 });
	});

	test("R2 events create and finalize video summary and transcript Markdown siblings", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, db.userId);
			return db;
		});
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "video",
			displayName: "Video",
			description: "Video markdown generation",
			contentTypes: ["video/mp4", "audio/wav"],
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
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!asset) {
			throw new Error("Expected upload asset");
		}
		const assetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset._id,
		});
		const pluginRunnerRequests: Record<string, unknown>[] = [];
		stub_r2_and_modal_fetch({
			onPluginRunnerRequest: async (body) => {
				pluginRunnerRequests.push(body);
				const host = body.host as { token: string };
				const source = (body.input as { source: { name: string } }).source;
				for (const [path, markdown] of [
					[`${source.name}.transcript.md`, "# Plugin transcript\n\nPLUGIN_VIDEO_TRANSCRIPT_E2E_2026"],
					[`${source.name}.summary.md`, "# Plugin summary\n\nPLUGIN_VIDEO_SUMMARY_E2E_2026"],
				] as const) {
					const writeResponse = await t.fetch("/api/plugins/v1/write-markdown", {
						method: "POST",
						headers: {
							Authorization: `Bearer ${host.token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							pluginRunId: body.pluginRunId,
							path,
							markdown,
						}),
					});
					expect(writeResponse.status).toBe(200);
				}
				return new Response(JSON.stringify({ status: "succeeded" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
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
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					path: "/clip.mp4.summary.md",
				}),
				get_active_file_node_by_path(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					path: "/clip.mp4.transcript.md",
				}),
			]);
			return { summary, transcript };
		});
		expect(pendingOutputs.summary).toBeNull();
		expect(pendingOutputs.transcript).toBeNull();

		const pluginRun = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique(),
		);
		if (!pluginRun) {
			throw new Error("Expected plugin event run");
		}
		expect(pluginRun.outputAssetId).toBeUndefined();
		expect(pluginRun.status).toBe("queued");

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		const [summaryReadResult, transcriptReadResult] = await Promise.all([
			asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/clip.mp4.summary.md",
			}),
			asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/clip.mp4.transcript.md",
			}),
		]);
		expect(summaryReadResult?.content).toContain("PLUGIN_VIDEO_SUMMARY_E2E_2026");
		expect(transcriptReadResult?.content).toContain("PLUGIN_VIDEO_TRANSCRIPT_E2E_2026");
		expect(pluginRunnerRequests).toHaveLength(1);
		expect(pluginRunnerRequests[0]).toMatchObject({
			pluginName: "video",
			pluginVersion: "0.1.0",
			artifactKey: "plugins/video/backend/worker.js",
			artifactHash: `sha256:${"b".repeat(64)}`,
			input: {
				event: "files.upload.completed",
				source: {
					name: "clip.mp4",
					contentType: "video/mp4",
				},
			},
		});
		const processedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(processedAsset?.processingWorkId).toBeNull();
		const completedRun = await t.run(async (ctx) => ctx.db.get("plugins_event_runs", pluginRun._id));
		expect(completedRun).toMatchObject({ status: "succeeded", hostWriteCount: 2 });

		const audioUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "voice.wav",
			contentType: "audio/wav",
			size: 4096,
		});
		if (audioUpload._nay) {
			throw new Error(audioUpload._nay.message);
		}
		const audioAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", audioUpload._yay.assetId));
		if (!audioAsset) {
			throw new Error("Expected upload asset");
		}
		const audioAssetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: audioAsset._id,
		});

		const audioResponse = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_audio",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: audioAsset.r2Bucket,
					object: {
						key: audioAssetR2Key,
						size: 4096,
						eTag: "etag_audio",
					},
					eventTime: "2026-05-11T00:02:00.000Z",
				},
			}),
		});
		expect(audioResponse.status).toBe(204);

		const audioPluginRun = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", audioUpload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique(),
		);
		if (!audioPluginRun) {
			throw new Error("Expected plugin event run");
		}

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: audioPluginRun._id,
		});

		const audioTranscriptReadResult = await asUser.action(
			internal.files_nodes.get_file_last_available_markdown_content_by_path,
			{
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/voice.wav.transcript.md",
			},
		);
		expect(audioTranscriptReadResult?.content).toContain("PLUGIN_VIDEO_TRANSCRIPT_E2E_2026");
		expect(pluginRunnerRequests).toHaveLength(2);
		expect(pluginRunnerRequests[1]).toMatchObject({
			pluginName: "video",
			input: {
				event: "files.upload.completed",
				source: {
					name: "voice.wav",
					contentType: "audio/wav",
				},
			},
		});
		const completedAudioRun = await t.run(async (ctx) => ctx.db.get("plugins_event_runs", audioPluginRun._id));
		expect(completedAudioRun).toMatchObject({ status: "succeeded", hostWriteCount: 2 });
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
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!asset) {
			throw new Error("Expected upload asset");
		}
		const assetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset._id,
		});
		const markdownContent = "# Uploaded\n\nMarkdown body";
		r2Objects.set(assetR2Key, new TextEncoder().encode(markdownContent));

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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 1024,
						eTag: "etag_markdown",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const uploadedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(uploadedAsset?.processingWorkId).toBe("work_asset_refactor");

		await asUser.action(internal.r2.finalize_uploaded_markdown_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const contentAsset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;

			return { fileNode, asset, contentAsset };
		});

		expect(docs.fileNode?.assetId).not.toBe(upload._yay.assetId);
		expect(docs.fileNode?.contentType).toBe("text/markdown;charset=utf-8");
		expect(docs.fileNode?.yjsSnapshotId).toEqual(expect.any(String));
		expect(docs.fileNode?.yjsLastSequenceId).toEqual(expect.any(String));
		expect(docs.contentAsset?.kind).toBe("content");
		expect(docs.contentAsset?.r2Key ? r2_text(docs.contentAsset.r2Key) : null).toBe(markdownContent);
		expect(docs.asset?.processingWorkId).toBeNull();
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
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!asset) {
			throw new Error("Expected upload asset");
		}
		const assetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset._id,
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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 1024,
						eTag: "etag_not_pdf",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const docs = await t.run(async (ctx) => {
			const nextAsset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const generated = await get_active_file_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: "/not-a-pdf.pdf.md",
			});
			return { nextAsset, generated };
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
		expect(docs.nextAsset?.processingWorkId).toBeNull();
		expect(docs.generated).toBeNull();
	});

	test("archives active generated output name conflicts before plugin writes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "pdf",
			displayName: "PDF",
			description: "PDF markdown generation",
			contentTypes: ["application/pdf"],
		});
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "collision.pdf.md",
				kind: "file",
				path: "/collision.pdf.md",
				treePath: "/collision.pdf.md",
			}),
		);
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		if (!asset) {
			throw new Error("Expected upload asset");
		}
		const assetR2Key = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset._id,
		});
		stub_r2_and_modal_fetch({
			onPluginRunnerRequest: async (body) => {
				const host = body.host as { token: string };
				const writeResponse = await t.fetch("/api/plugins/v1/write-markdown", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						pluginRunId: body.pluginRunId,
						path: "collision.pdf.md",
						markdown: "# Collision replacement\n\nPLUGIN_COLLISION_E2E_2026",
					}),
				});
				expect(writeResponse.status).toBe(200);
				return new Response(JSON.stringify({ status: "succeeded" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
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
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 4096,
						eTag: "etag_collision",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const pluginRun = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique(),
		);
		if (!pluginRun) {
			throw new Error("Expected plugin event run");
		}
		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const oldGenerated = await ctx.db.get("files_nodes", existingGeneratedId);
			const activeGeneratedAtPath = await get_active_file_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: "/collision.pdf.md",
			});
			const activeGeneratedAsset = activeGeneratedAtPath?.assetId
				? await ctx.db.get("files_r2_assets", activeGeneratedAtPath.assetId)
				: null;
			return { fileNode, oldGenerated, activeGeneratedAtPath, activeGeneratedAsset };
		});

		expect(docs.oldGenerated?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.fileNode?.assetId).toBe(upload._yay.assetId);
		expect(docs.activeGeneratedAtPath?.name).toBe("collision.pdf.md");
		expect(docs.activeGeneratedAtPath?._id).not.toBe(existingGeneratedId);
		expect(docs.activeGeneratedAtPath).toMatchObject({
			name: "collision.pdf.md",
			contentType: "text/markdown;charset=utf-8",
			yjsSnapshotId: expect.any(String),
		});
		expect(docs.activeGeneratedAtPath?.archiveOperationId).toBeUndefined();
		expect(docs.activeGeneratedAsset?.r2Key ? r2_text(docs.activeGeneratedAsset.r2Key) : null).toContain(
			"PLUGIN_COLLISION_E2E_2026",
		);
	});
});
