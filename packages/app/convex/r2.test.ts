import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_INITIAL_CONTENT,
	files_MAX_TEXT_CONTENT_BYTES,
	files_ROOT_ID,
	files_YJS_DOC_KEYS,
	files_db_load_pending_update_yjs_state_bytes,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_create_from_array_buffer_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
} from "../shared/files-metadata.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return {
		...actual,
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
	};
});

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
					new Response(
						JSON.stringify({ _yay: { pluginStatus: 200, elapsedMs: 12, outputBytes: 0, outputTruncated: false } }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					)
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
	const repositoryId = await t.run(async (ctx) => {
		const repositoryUrl = `https://github.com/bonobo/${args.name}-plugin`;
		const existing = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_ownerUser_repositoryUrl", (q) =>
				q.eq("ownerUserId", args.userId).eq("repositoryUrl", repositoryUrl),
			)
			.first();
		return (
			existing?._id ??
			(await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: args.userId,
				repositoryUrl,
				owner: "bonobo",
				repo: `${args.name}-plugin`,
			}))
		);
	});
	const registered = await t.action(internal.plugins.register_plugin_version, {
		repositoryId,
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
		configuration: {
			description: "Choose which upload folders start this plugin.",
			defaultYaml: "triggers:\n  files.upload.completed:\n    folders:\n      - /\n",
		},
		events: [
			{
				type: "files.upload.completed",
				contentTypes: args.contentTypes,
				filters: [
					{
						field: "source.path",
						operator: "pathIsUnderAny",
						configurationPath: ["triggers", "files.upload.completed", "folders"],
					},
				],
			},
		],
		pages: [],
		fileViews: [],
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
	test("creates Markdown nodes with Yjs and version snapshot assets", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
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
		// Editable files have no content asset row: the node points at its first version snapshot.
		expect(docs.markdownAsset?.kind).toBe("content_snapshot");
		expect(docs.markdownAsset?._id).toBe(docs.snapshots[0]?.assetId);
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

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
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
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			const yjsSnapshotAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			if (!yjsSnapshotAsset?.r2Key) {
				throw new Error("Expected Yjs snapshot R2 key");
			}

			return { yjsSnapshotR2Key: yjsSnapshotAsset.r2Key };
		});
		const baseSnapshotBytes = r2Objects.get(assets.yjsSnapshotR2Key);
		if (!baseSnapshotBytes) {
			throw new Error("Expected Yjs snapshot bytes in R2");
		}

		const updatedMarkdown = "# Stale read\n\nThis content only exists in Yjs updates.\n";
		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(baseSnapshotBytes));
		const nextYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(baseSnapshotBytes));
		const nextProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: nextYjsDoc,
			text: updatedMarkdown,
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

		const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/stale-read.md",
		});

		expect(readResult?.content).toBe(updatedMarkdown);
		expect(readResult?.pendingUpdateId).toBeNull();
	});

	test("refuses the signed download when access is lost during materialization", async () => {
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

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "revoked-download.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const assets = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!node?.assetId || !node.yjsSnapshotId) {
				throw new Error("Expected Markdown node assets");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			const yjsSnapshotAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			if (!yjsSnapshotAsset?.r2Key) {
				throw new Error("Expected Yjs snapshot R2 key");
			}

			return { yjsSnapshotR2Key: yjsSnapshotAsset.r2Key };
		});
		const baseSnapshotBytes = r2Objects.get(assets.yjsSnapshotR2Key);
		if (!baseSnapshotBytes) {
			throw new Error("Expected Yjs snapshot bytes in R2");
		}

		// Push a Yjs update so the download action must materialize and re-read the node.
		const updatedMarkdown = "# Revoked download\n\nThis content only exists in Yjs updates.\n";
		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(baseSnapshotBytes));
		const nextYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(baseSnapshotBytes));
		const nextProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: nextYjsDoc,
			text: updatedMarkdown,
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
			sessionId: "revoked-download-session",
		});
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}

		// Delete the membership while the action materializes, so the re-read after
		// materialization runs with the caller's access already gone.
		let membershipDeleted = false;
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
			if (!membershipDeleted) {
				membershipDeleted = true;
				await t.run(async (ctx) => ctx.db.delete("organizations_workspaces_users", db.membershipId));
			}
			return {
				key: customKey ?? "test-upload-key",
				url: r2_url("upload", customKey ?? "test-upload-key"),
			};
		});

		const signedDownload = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: created._yay.nodeId,
		});
		expect(membershipDeleted).toBe(true);
		expect(signedDownload._nay).toMatchObject({ message: "Not found" });
	});

	test("refuses signed downloads and asset reads for archived nodes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "archived-download.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) =>
			ctx.db.patch("files_nodes", created._yay.nodeId, { archiveOperationId: "archive-download-test" }),
		);

		const signedDownload = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: created._yay.nodeId,
		});
		expect(signedDownload._nay).toMatchObject({ message: "Not found" });

		const asset = await asUser.query(api.r2.get_asset, {
			membershipId: db.membershipId,
			fileNodeId: created._yay.nodeId,
		});
		expect(asset).toBeNull();
	});

	test("reads pending-update Markdown before saved R2 content", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "pending-read.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const pendingMarkdown = "# Pending edit\n\nThis content is still in the agent draft.\n";
		// Stage the text under a server-side batch first: the internal action carries only ids.
		const upsertBatch = await t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId: created._yay.nodeId,
			},
		);
		if (upsertBatch._nay) {
			throw new Error(upsertBatch._nay.message);
		}
		const upsertText = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			operationBatchId: upsertBatch._yay.operationBatchId,
			role: "unstaged",
			text: pendingMarkdown,
		});
		if (upsertText._nay) {
			throw new Error(upsertText._nay.message);
		}
		const upsertResult = await asUser.action(
			internal.files_pending_updates.upsert_file_pending_update_internal_action,
			{
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId: created._yay.nodeId,
				operationBatchId: upsertBatch._yay.operationBatchId,
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
		if (!pendingUpdate || !files_pending_update_has_yjs_content(pendingUpdate)) {
			throw new Error("Expected pending update with content");
		}
		// The unstaged branch is a full paged state now; reassemble it and read its markdown.
		const unstagedBytes = await t.run(async (ctx) => {
			const stateDoc = await ctx.db.get("files_pending_update_yjs_states", pendingUpdate.unstagedStateId);
			if (!stateDoc) {
				throw new Error("Expected the unstaged pending state doc");
			}
			const bytes = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc });
			if (bytes._nay) {
				throw new Error(bytes._nay.message);
			}
			// Return an ArrayBuffer: `t.run` serializes the return value as a Convex value, and
			// Convex bytes are ArrayBuffers, not Uint8Arrays.
			return files_u8_to_array_buffer(bytes._yay);
		});
		const pendingYjsDoc = files_yjs_doc_create_from_array_buffer_update(unstagedBytes);
		const pendingRowMarkdown = files_yjs_doc_get_text({ rootKind: "rich_text", yjsDoc: pendingYjsDoc });
		pendingYjsDoc.destroy();
		if (pendingRowMarkdown._nay) {
			throw new Error(pendingRowMarkdown._nay.message);
		}
		expect(pendingRowMarkdown._yay).toBe(pendingMarkdown);

		const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
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
		let downloadRequestedAt = 0;
		let downloadUrlExpiresAt = 0;
		stub_r2_and_modal_fetch({
			onPluginRunnerRequest: async (body) => {
				pluginRunnerRequests.push(body);
				const host = body.host as { token: string };
				const source = (body.input as { source: { fileNodeId: string; path: string } }).source;
				downloadRequestedAt = Date.now();
				const downloadResponse = await t.fetch("/api/v1/files/download-urls", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						fileNodeIds: [source.fileNodeId],
						// The 15-minute request ceiling exceeds the 10-minute run-token life: clamp must win.
						expiresInSeconds: 900,
					}),
				});
				expect(downloadResponse.status).toBe(200);
				const downloadBody = (await downloadResponse.json()) as {
					items: Array<{ url: string; expiresAt: number }>;
				};
				expect(downloadBody.items[0]?.url).toContain(encodeURIComponent(assetR2Key));
				downloadUrlExpiresAt = downloadBody.items[0]!.expiresAt;

				const writeResponse = await t.fetch("/api/v1/files/write", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						path: `${source.path}.md`,
						content: "# Plugin PDF extraction\n\nPLUGIN_PDF_E2E_2026",
					}),
				});
				expect(writeResponse.status).toBe(200);
				return new Response(
					JSON.stringify({ _yay: { pluginStatus: 200, elapsedMs: 12, outputBytes: 0, outputTruncated: false } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
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
		expect(pluginRun.status).toBe("queued");

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		// The signed URL never outlives the run token: the 900s request was clamped to the token's
		// remaining life (run expiresAt doubles as apiTokenExpiresAt at start_event_run).
		expect(downloadUrlExpiresAt).toBeGreaterThan(0);
		expect(downloadUrlExpiresAt).toBeLessThan(downloadRequestedAt + 900 * 1000);
		expect(downloadUrlExpiresAt).toBeLessThanOrEqual(pluginRun.expiresAt + 1000);

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
		// Public-API writes stage the content as the file's first version snapshot.
		expect(docs.outputAsset?.kind).toBe("content_snapshot");
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
					path: "/event.pdf",
					contentType: "application/pdf",
				},
			},
		});
		const completedRun = await t.run(async (ctx) => ctx.db.get("plugins_event_runs", pluginRun._id));
		// One download-urls call plus one write call against the shared quota, one published output.
		expect(completedRun).toMatchObject({ status: "succeeded", apiCallCount: 2, outputWriteCount: 1 });

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
				const source = (body.input as { source: { path: string } }).source;
				const writeResponse = await t.fetch("/api/v1/files/write", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						path: `${source.path}.description.md`,
						content: "# Plugin image description\n\nPLUGIN_IMAGE_E2E_2026",
					}),
				});
				expect(writeResponse.status).toBe(200);
				return new Response(
					JSON.stringify({ _yay: { pluginStatus: 200, elapsedMs: 12, outputBytes: 0, outputTruncated: false } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
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
		expect(pluginRun.status).toBe("queued");

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
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
		expect(completedRun).toMatchObject({ status: "succeeded", apiCallCount: 1, outputWriteCount: 1 });
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
				const source = (body.input as { source: { path: string } }).source;
				for (const [path, content] of [
					[`${source.path}.transcript.md`, "# Plugin transcript\n\nPLUGIN_VIDEO_TRANSCRIPT_E2E_2026"],
					[`${source.path}.summary.md`, "# Plugin summary\n\nPLUGIN_VIDEO_SUMMARY_E2E_2026"],
				] as const) {
					const writeResponse = await t.fetch("/api/v1/files/write", {
						method: "POST",
						headers: {
							Authorization: `Bearer ${host.token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							path,
							content,
						}),
					});
					expect(writeResponse.status).toBe(200);
				}
				return new Response(
					JSON.stringify({ _yay: { pluginStatus: 200, elapsedMs: 12, outputBytes: 0, outputTruncated: false } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
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
		expect(pluginRun.status).toBe("queued");

		await asUser.action(internal.plugins_runtime.execute_upload_completed_event_run, {
			runId: pluginRun._id,
		});

		const [summaryReadResult, transcriptReadResult] = await Promise.all([
			asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/clip.mp4.summary.md",
			}),
			asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
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
		expect(completedRun).toMatchObject({ status: "succeeded", apiCallCount: 2, outputWriteCount: 2 });

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
			internal.files_nodes_content.get_file_last_available_text_content_by_path,
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
		expect(completedAudioRun).toMatchObject({ status: "succeeded", apiCallCount: 2, outputWriteCount: 2 });
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

		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
			eventId: "event_markdown",
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
		// The promoted node points at its first version snapshot, not a content asset row.
		expect(docs.contentAsset?.kind).toBe("content_snapshot");
		expect(docs.contentAsset?.r2Key ? r2_text(docs.contentAsset.r2Key) : null).toBe(markdownContent);
		expect(docs.asset?.processingWorkId).toBeNull();

		// Producer shape pair: a node born with a `yjsRootKind` that does not match its first Yjs
		// snapshot is invisible to every later guard, so read both sides of this producer's write.
		expect(docs.fileNode?.yjsRootKind).toBe("rich_text");
		const yjsSnapshotR2Key = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			if (!fileNode?.yjsSnapshotId) {
				throw new Error("Expected the promoted node to hold a Yjs snapshot pointer");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			const yjsSnapshotAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			return yjsSnapshotAsset?.r2Key ?? null;
		});
		const yjsSnapshotBytes = yjsSnapshotR2Key ? r2Objects.get(yjsSnapshotR2Key) : undefined;
		if (!yjsSnapshotBytes) {
			throw new Error("Expected the uploaded Yjs snapshot bytes to be captured");
		}
		const snapshotYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(yjsSnapshotBytes));
		expect([...snapshotYjsDoc.share.keys()]).toEqual([files_YJS_DOC_KEYS.richText]);
	});

	test("finalizes an uploaded plain text file into a Y.Text document with the classifier content type", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		// The client media type is deliberately wrong for a .yaml name: the classifier over the
		// The node name must pick both the document shape and the stored content type.
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "notes.yaml",
			contentType: "text/plain;charset=utf-8",
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
		// BOM + CRLF in the uploaded bytes: the producer boundary must store LF text without a BOM.
		r2Objects.set(assetR2Key, new TextEncoder().encode("\uFEFFkey: value\r\nother: 2\r\n"));

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_yaml",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 1024,
						eTag: "etag_yaml",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const uploadedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(uploadedAsset?.processingWorkId).toBe("work_asset_refactor");

		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
			eventId: "event_yaml",
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const contentAsset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;

			return { fileNode, asset, contentAsset };
		});

		expect(docs.fileNode?.yjsRootKind).toBe("plain_text");
		expect(docs.fileNode?.contentType).toBe("application/yaml");
		expect(docs.fileNode?.yjsSnapshotId).toEqual(expect.any(String));
		expect(docs.fileNode?.yjsLastSequenceId).toEqual(expect.any(String));
		expect(docs.contentAsset?.kind).toBe("content_snapshot");
		expect(docs.contentAsset?.r2Key ? r2_text(docs.contentAsset.r2Key) : null).toBe("key: value\nother: 2\n");
		expect(docs.asset?.processingWorkId).toBeNull();

		// Producer shape pair: the first Yjs snapshot must hold the Y.Text root the stamped
		// `yjsRootKind` promises, and its text must round-trip the normalized upload.
		const yjsSnapshotR2Key = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			if (!fileNode?.yjsSnapshotId) {
				throw new Error("Expected the promoted node to hold a Yjs snapshot pointer");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			const yjsSnapshotAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			return yjsSnapshotAsset?.r2Key ?? null;
		});
		const yjsSnapshotBytes = yjsSnapshotR2Key ? r2Objects.get(yjsSnapshotR2Key) : undefined;
		if (!yjsSnapshotBytes) {
			throw new Error("Expected the uploaded Yjs snapshot bytes to be captured");
		}
		const snapshotYjsDoc = files_yjs_doc_create_from_array_buffer_update(array_buffer_from_bytes(yjsSnapshotBytes));
		expect([...snapshotYjsDoc.share.keys()]).toEqual([files_YJS_DOC_KEYS.plainText]);
		expect(files_yjs_doc_get_text({ yjsDoc: snapshotYjsDoc, rootKind: "plain_text" })).toEqual({
			_yay: "key: value\nother: 2\n",
		});
	});

	test("converts an over-cap frontmatter upload with the frontmatter marker instead of throwing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		// The installed plugin subscribes to the Markdown type. Successful conversion suppresses the upload event
		// on every successful conversion, and this marked publish IS a successful conversion, so
		// no event run may appear for it either.
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "pdf",
			displayName: "Markdown watcher",
			description: "Watches markdown uploads",
			contentTypes: ["text/markdown;charset=utf-8"],
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "frontmatter-overcap.md",
			contentType: "text/markdown;charset=utf-8",
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
		// 129 frontmatter fields, mirroring the qa-frontmatter-overcap.md fixture: over the field
		// cap while the byte size stays far under the content cap. The markdown itself is valid,
		// so the conversion must publish an editable node instead of throwing the insert
		// backstop inside the infinite-retry workpool.
		const overCapMarkdown = `---\n${Array.from({ length: files_metadata_MAX_FRONTMATTER_FIELDS + 1 }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body\n`;
		r2Objects.set(assetR2Key, new TextEncoder().encode(overCapMarkdown));

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_frontmatter_overcap",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 4096,
						eTag: "etag_frontmatter_overcap",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
			eventId: "event_frontmatter_overcap",
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", upload._yay.nodeId),
				)
				.collect();
			const pluginRun = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique();

			return { fileNode, asset, metadataDocs, pluginRun };
		});

		// The node publishes editable with the marker pair set from its first publish, exactly
		// like a materialization settle would set it.
		expect(docs.fileNode?.yjsRootKind).toBe("rich_text");
		expect(docs.fileNode?.yjsSnapshotId).toEqual(expect.any(String));
		expect(docs.fileNode?.contentFrontmatterTooLargeFieldCount).toBe(files_metadata_MAX_FRONTMATTER_FIELDS + 1);
		expect(docs.fileNode?.contentFrontmatterTooLargeIndexDocumentCount).toBeGreaterThan(
			files_metadata_MAX_FRONTMATTER_FIELDS + 1,
		);
		expect(docs.asset?.processingWorkId).toBeNull();
		// The over-cap frontmatter is committed as chunk content but never indexed.
		expect(docs.metadataDocs).toHaveLength(0);
		// Only stored-blob exits dispatch the plugin upload event. This publish is a
		// successful conversion, so it keeps the suppression every other conversion has.
		expect(docs.pluginRun).toBeNull();
	});

	test("converts an upload whose frontmatter values overflow the index-document cap with the marker pair", async () => {
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
			filename: "frontmatter-values-overcap.md",
			contentType: "text/markdown;charset=utf-8",
			size: 8192,
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
		// One field with 600 distinct tag values, mirroring the qa-frontmatter-values-overcap.md
		// fixture: the field count stays under its cap while the index-document count (1 field +
		// 600 values) crosses 512.
		const valuesOverCapMarkdown = `---\ntags:\n${Array.from({ length: 600 }, (_, index) => `  - tag_${index}`).join("\n")}\n---\n\n# Body\n`;
		r2Objects.set(assetR2Key, new TextEncoder().encode(valuesOverCapMarkdown));

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_frontmatter_values_overcap",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 8192,
						eTag: "etag_frontmatter_values_overcap",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
			eventId: "event_frontmatter_values_overcap",
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", upload._yay.nodeId),
				)
				.collect();

			return { fileNode, asset, metadataDocs };
		});

		// The index-document half of the pair is the one this content crosses; the field count is
		// recorded beside it as the fresh preflight measured it.
		expect(docs.fileNode?.yjsRootKind).toBe("rich_text");
		expect(docs.fileNode?.yjsSnapshotId).toEqual(expect.any(String));
		expect(docs.fileNode?.contentFrontmatterTooLargeFieldCount).toBe(1);
		expect(docs.fileNode?.contentFrontmatterTooLargeIndexDocumentCount).toBe(601);
		expect(docs.fileNode?.contentFrontmatterTooLargeIndexDocumentCount).toBeGreaterThan(
			files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
		);
		expect(docs.asset?.processingWorkId).toBeNull();
		expect(docs.metadataDocs).toHaveLength(0);
	});

	test("falls back to the stored blob on invalid UTF-8 and dispatches the plugin upload event", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		// The installed plugin subscribes to this upload's content type, so the fallback settle is
		// the only step that can create its event run.
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "pdf",
			displayName: "JSON watcher",
			description: "Watches JSON uploads",
			contentTypes: ["application/json"],
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "data.json",
			contentType: "application/json",
			size: 16,
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
		// 0xff can never appear in UTF-8, so the fatal decode refuses on every retry: the upload
		// must stay a stored blob instead of storing replacement characters as editable text.
		r2Objects.set(assetR2Key, new Uint8Array([0x48, 0xff, 0xfe]));

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_invalid_utf8",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: 16,
						eTag: "etag_invalid_utf8",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		// The conversion is still pending, so the plugin event must not exist yet.
		const pluginRunBeforeSettle = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique(),
		);
		expect(pluginRunBeforeSettle).toBeNull();

		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
			eventId: "event_invalid_utf8",
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const pluginRun = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload._yay.assetId).eq("event", "files.upload.completed"),
				)
				.unique();

			return { fileNode, asset, pluginRun };
		});

		// The node stays a stored blob pointing at the original upload.
		expect(docs.fileNode?.assetId).toBe(upload._yay.assetId);
		expect(docs.fileNode?.yjsSnapshotId).toBeUndefined();
		expect(docs.fileNode?.yjsRootKind).toBeUndefined();
		expect(docs.asset?.processingWorkId).toBeNull();
		// Every stored-blob fallback exit dispatches the plugin upload event.
		expect(docs.pluginRun).toMatchObject({ event: "files.upload.completed" });
	});

	test("keeps an over-cap upload as a stored blob without downloading it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const overCapSize = files_MAX_TEXT_CONTENT_BYTES + 1;
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "big.txt",
			contentType: "text/plain;charset=utf-8",
			size: overCapSize,
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
		// No bytes are seeded on purpose: the pre-download size check must settle the fallback
		// before any bucket read, so a download attempt would fail this test.

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_over_cap",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset.r2Bucket,
					object: {
						key: assetR2Key,
						size: overCapSize,
						eTag: "etag_over_cap",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload._yay.assetId,
			eventId: "event_over_cap",
		});

		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);

			return { fileNode, asset };
		});

		expect(docs.fileNode?.assetId).toBe(upload._yay.assetId);
		expect(docs.fileNode?.yjsSnapshotId).toBeUndefined();
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
				const source = (body.input as { source: { path: string } }).source;
				const writeResponse = await t.fetch("/api/v1/files/write", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${host.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						path: `${source.path}.md`,
						content: "# Collision replacement\n\nPLUGIN_COLLISION_E2E_2026",
					}),
				});
				expect(writeResponse.status).toBe(200);
				return new Response(
					JSON.stringify({ _yay: { pluginStatus: 200, elapsedMs: 12, outputBytes: 0, outputTruncated: false } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
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

describe("cleanup_expired_unfinalized_assets", () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	async function seed_unfinalized_asset(
		t: ReturnType<typeof test_convex>,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			unfinalizedExpiresAt?: number;
			r2Key?: string;
		},
	) {
		return await t.run(async (ctx) =>
			ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				r2Key: args.r2Key,
				size: 128,
				createdBy: args.userId,
				unfinalizedExpiresAt: args.unfinalizedExpiresAt,
				updatedAt: Date.now(),
			}),
		);
	}

	test("deletes expired unreferenced assets with their R2 objects and keeps unexpired ones", async () => {
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const expiredAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });
		const unexpiredAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now + DAY_MS });

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		const [expiredAsset, unexpiredAsset] = await t.run(async (ctx) =>
			Promise.all([ctx.db.get("files_r2_assets", expiredAssetId), ctx.db.get("files_r2_assets", unexpiredAssetId)]),
		);
		expect(swept).toEqual({ deletedCount: 1, done: true });
		expect(expiredAsset).toBeNull();
		expect(unexpiredAsset?.unfinalizedExpiresAt).toBe(now + DAY_MS);
		expect(deleteObjectSpy).toHaveBeenCalledWith(
			expect.anything(),
			expected_asset_key({ organizationId: db.organizationId, workspaceId: db.workspaceId, assetId: expiredAssetId }),
		);
	});

	test("reaches an orphan in the first batch even when finalized assets exist", async () => {
		// Guards the two-sided index range: `unfinalizedExpiresAt` is missing on finalized assets,
		// and a missing value sorts below every number. With a one-sided `.lt(now)` range this
		// batch of one would contain only the finalized asset and the orphan would never be seen.
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const finalizedAssetId = await seed_unfinalized_asset(t, { ...db, r2Key: "test/finalized" });
		const orphanAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: now,
			batchSize: 1,
			_test_disableReschedule: true,
		});

		const [finalizedAsset, orphanAsset] = await t.run(async (ctx) =>
			Promise.all([ctx.db.get("files_r2_assets", finalizedAssetId), ctx.db.get("files_r2_assets", orphanAssetId)]),
		);
		expect(swept.deletedCount).toBe(1);
		expect(orphanAsset).toBeNull();
		expect(finalizedAsset).not.toBeNull();
	});

	test("a batched sweep reschedules itself until the backlog is drained", async () => {
		vi.useFakeTimers();
		try {
			const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const now = Date.now();
			const firstAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 2 });
			const secondAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });

			const firstBatch = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
				_test_now: now,
				batchSize: 1,
			});
			expect(firstBatch).toEqual({ deletedCount: 1, done: false });

			// The sweep schedules each continuation with runAfter(0). Advance fake timers once per
			// hop so every continuation in the chain gets to run.
			for (let i = 0; i < 5; i += 1) {
				vi.advanceTimersByTime(1000);
				await t.finishInProgressScheduledFunctions();
			}

			const [firstAsset, secondAsset] = await t.run(async (ctx) =>
				Promise.all([ctx.db.get("files_r2_assets", firstAssetId), ctx.db.get("files_r2_assets", secondAssetId)]),
			);
			expect(firstAsset).toBeNull();
			expect(secondAsset).toBeNull();
			expect(deleteObjectSpy).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("never deletes an asset a node or snapshot doc still references", async () => {
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const nodeAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });
		const yjsSnapshotAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });
		const versionSnapshotAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });
		await t.run(async (ctx) => {
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "broken.pdf",
				kind: "file",
				path: "/broken.pdf",
				treePath: "/broken.pdf",
				assetId: nodeAssetId,
			});
			await ctx.db.insert("files_yjs_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				assetId: yjsSnapshotAssetId,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
			});
			await ctx.db.insert("files_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				assetId: versionSnapshotAssetId,
				createdBy: db.userId,
				archivedAt: -1,
			});
		});

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		const assets = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get("files_r2_assets", nodeAssetId),
				ctx.db.get("files_r2_assets", yjsSnapshotAssetId),
				ctx.db.get("files_r2_assets", versionSnapshotAssetId),
			]),
		);
		expect(swept.deletedCount).toBe(0);
		for (const asset of assets) {
			expect(asset).not.toBeNull();
			// Referenced assets are pushed forward by the exact 7-day recheck delay so the sweep
			// warns again later instead of looping on them every hour.
			expect(asset?.unfinalizedExpiresAt).toBe(now + 7 * DAY_MS);
		}
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("heals a finalized asset that kept a stale deadline", async () => {
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const driftedAssetId = await seed_unfinalized_asset(t, {
			...db,
			r2Key: "test/finalized-with-stale-deadline",
			unfinalizedExpiresAt: now - 1,
		});

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		const driftedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", driftedAssetId));
		expect(swept.deletedCount).toBe(0);
		expect(driftedAsset).not.toBeNull();
		expect(driftedAsset?.unfinalizedExpiresAt).toBeUndefined();
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("insert_asset sets the deadline and the r2Key patch clears it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const assetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			size: 64,
			createdBy: db.userId,
		});
		const inserted = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(inserted?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());

		// A patch without r2Key must keep the deadline: the asset is still unfinalized.
		await t.mutation(internal.r2.patch_asset, { assetId, processingWorkId: null });
		const stillUnfinalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(stillUnfinalized?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());

		await t.mutation(internal.r2.patch_asset, { assetId, r2Key: "test/confirmed" });
		const finalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(finalized?.r2Key).toBe("test/confirmed");
		expect(finalized?.unfinalizedExpiresAt).toBeUndefined();
	});

	test("upload finalization through the R2 event clears the deadline", async () => {
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
			filename: "sweep-check.png",
			contentType: "image/png",
			size: 2048,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const pending = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(pending?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());

		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_sweep_check",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: pending?.r2Bucket,
					object: {
						key: expected_asset_key({
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							assetId: upload._yay.assetId,
						}),
						size: 2048,
						eTag: "etag_sweep_check",
					},
					eventTime: "2026-05-11T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const finalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(finalized?.r2Key).toBeDefined();
		expect(finalized?.unfinalizedExpiresAt).toBeUndefined();
	});
});
