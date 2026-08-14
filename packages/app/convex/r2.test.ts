import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex as test_convex_base, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	r2_confirmed_object_delete,
	r2_enqueue_object_deletion_job,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
} from "./r2_client.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
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
const r2ObjectMetadata = new Map<string, { size: number; etag?: string }>();
const preserveR2EventMetadataKeys = new Set<string>();
let enqueueActionSpy: MockInstance;
let confirmedDeleteSpy: MockInstance;

function test_convex() {
	const t = test_convex_base();
	const fetch = t.fetch.bind(t);
	t.fetch = async (path, init) => {
		if (path === "/api/r2/event" && typeof init?.body === "string") {
			const body = JSON.parse(init.body) as {
				event?: { action?: unknown; object?: { key?: unknown; size?: unknown; eTag?: unknown } };
			};
			const object = body.event?.object;
			if (
				body.event?.action === "PutObject" &&
				typeof object?.key === "string" &&
				object.key.includes("/upload-staging/") &&
				typeof object.size === "number" &&
				typeof object.eTag === "string" &&
				!preserveR2EventMetadataKeys.delete(object.key)
			) {
				r2ObjectMetadata.set(object.key, { size: object.size, etag: object.eTag });
			}
		}
		return await fetch(path, init);
	};
	return t;
}

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

function expected_upload_staging_key(args: {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	assetId: string;
}) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/upload-staging/${args.assetId}`;
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
				const key = key_from_r2_url(url);
				if (new Headers(init.headers).get("If-None-Match") === "*" && r2Objects.has(key)) {
					return new Response(null, { status: 412 });
				}
				const bytes = await body_to_bytes(init.body);
				r2Objects.set(key, bytes);
				r2ObjectMetadata.set(key, { size: bytes.byteLength, etag: `etag_bytes_${bytes.byteLength}` });
				return new Response(null, { status: 200 });
			}

			if (url.startsWith("https://r2.test/object/")) {
				const key = key_from_r2_url(url);
				const bytes = r2Objects.get(key);
				const metadata = r2ObjectMetadata.get(key);
				const responseHeaders =
					metadata === undefined
						? undefined
						: {
								"Content-Length": String(metadata.size),
								...(metadata.etag === undefined ? {} : { ETag: metadata.etag }),
							};
				return bytes
					? new Response(bytes_to_response_body(bytes), {
							status: 200,
							headers: responseHeaders ?? { "Content-Length": String(bytes.byteLength) },
						})
					: key.includes("/upload-staging/")
						? new Response(new Uint8Array(), { status: 200, headers: responseHeaders })
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

async function post_r2_put_event(
	t: ReturnType<typeof test_convex>,
	args: {
		bucket: string;
		key: string;
		size: number;
		messageId: string;
		etag?: string;
		preserveObjectMetadata?: boolean;
	},
) {
	const parsedAssetId = args.key.split("/").at(-1);
	const eventKey = await t.run(async (ctx) => {
		const assetId = parsedAssetId ? ctx.db.normalizeId("files_r2_assets", parsedAssetId) : null;
		const asset = assetId ? await ctx.db.get("files_r2_assets", assetId) : null;
		return asset?.uploadStagingR2Key ?? args.key;
	});
	if (eventKey !== args.key) {
		const bytes = r2Objects.get(args.key);
		if (bytes) {
			r2Objects.delete(args.key);
			r2Objects.set(eventKey, bytes);
		}
		const metadata = r2ObjectMetadata.get(args.key);
		if (metadata) {
			r2ObjectMetadata.delete(args.key);
			r2ObjectMetadata.set(eventKey, metadata);
		}
	}
	const eventEtag = args.etag ?? `etag_${args.messageId}`;
	if (!args.preserveObjectMetadata) {
		r2ObjectMetadata.set(eventKey, { size: args.size, etag: eventEtag });
	} else {
		preserveR2EventMetadataKeys.add(eventKey);
	}
	return await t.fetch("/api/r2/event", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			cloudflareMessageId: args.messageId,
			attempts: 1,
			event: {
				action: "PutObject",
				bucket: args.bucket,
				object: {
					key: eventKey,
					size: args.size,
					eTag: eventEtag,
				},
				eventTime: "2026-05-11T00:00:00.000Z",
			},
		}),
	});
}

async function get_deletion_job_by_key(t: ReturnType<typeof test_convex>, r2Key: string) {
	return await t.run(async (ctx) =>
		ctx.db
			.query("files_r2_object_deletion_jobs")
			.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
			.first(),
	);
}

/**
 * Wait for scheduled deletion work to finish. One job may schedule another job, so run several
 * rounds. Advance fake timers so `runAfter(0)` jobs can start.
 */
async function flush_scheduled(t: ReturnType<typeof test_convex>, rounds = 5) {
	for (let i = 0; i < rounds; i += 1) {
		if (vi.isFakeTimers()) {
			vi.advanceTimersByTime(1000);
		} else {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await t.finishInProgressScheduledFunctions();
	}
}

async function create_upload_fixture(
	t: ReturnType<typeof test_convex>,
	db: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		membershipId: Id<"organizations_workspaces_users">;
	},
	filename: string,
	contentType = "image/png",
) {
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const created = await asUser.mutation(api.files_nodes.create_upload_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		filename,
		contentType,
		size: 1024,
	});
	if (created._nay) {
		throw new Error(created._nay.message);
	}

	const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", created._yay.assetId));
	if (!asset?.uploadStagingR2Key) {
		throw new Error("Expected upload staging key");
	}

	return {
		nodeId: created._yay.nodeId,
		assetId: created._yay.assetId,
		key: asset.uploadStagingR2Key,
		liveKey: expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: created._yay.assetId,
		}),
	};
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
	r2ObjectMetadata.clear();
	preserveR2EventMetadataKeys.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: r2_url("upload", customKey ?? "test-upload-key"),
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string) => r2_url("object", key));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_asset_refactor" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	// Delete from the in-memory R2 map instead of calling the component's real S3 client.
	confirmedDeleteSpy = vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		r2Objects.delete(key);
		r2ObjectMetadata.delete(key);
	});
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

		const asset = await asUser.query(api.r2.get_asset_by_file_node_id, {
			membershipId: db.membershipId,
			fileNodeId: created._yay.nodeId,
		});
		expect(asset).toBeNull();
	});

	test("signs chat images only for generated_image assets in the caller's workspace", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other", workspaceName: "home" }),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const insertAsset = (args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			kind: "generated_image" | "content";
		}) =>
			t.run(async (ctx) =>
				ctx.db.insert("files_r2_assets", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					kind: args.kind,
					r2Bucket: "test-bucket",
					size: 128,
					createdBy: db.userId,
					unfinalizedExpiresAt: Date.now() + 60_000,
					updatedAt: Date.now(),
				}),
			);

		const generatedImageAssetId = await insertAsset({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "generated_image",
		});
		const fileAssetId = await insertAsset({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content",
		});
		const otherWorkspaceAssetId = await insertAsset({
			organizationId: other.organizationId,
			workspaceId: other.workspaceId,
			kind: "generated_image",
		});

		// The picture is signed before its message is stored, from the deterministic key.
		const signed = await asUser.action(api.r2.create_signed_chat_image_url, {
			membershipId: db.membershipId,
			assetId: generatedImageAssetId,
		});
		expect(signed._nay).toBeUndefined();
		expect(key_from_r2_url(signed._yay!.url)).toBe(
			expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: generatedImageAssetId,
			}),
		);

		// A file asset must not be reachable here: a file download also filters its node by
		// per-node visibility, and this path has no node to filter.
		const fileAsset = await asUser.action(api.r2.create_signed_chat_image_url, {
			membershipId: db.membershipId,
			assetId: fileAssetId,
		});
		expect(fileAsset._nay).toMatchObject({ message: "Not found" });

		const otherWorkspace = await asUser.action(api.r2.create_signed_chat_image_url, {
			membershipId: db.membershipId,
			assetId: otherWorkspaceAssetId,
		});
		expect(otherWorkspace._nay).toMatchObject({ message: "Not found" });

		const malformedId = await asUser.action(api.r2.create_signed_chat_image_url, {
			membershipId: db.membershipId,
			assetId: "not-an-id",
		});
		expect(malformedId._nay).toMatchObject({ message: "Not found" });
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
				expected_upload_staging_key({
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
		// Reusing the signed URL changes only the temporary object. The published asset keeps its
		// original final object and metadata.
		expect(duplicateAsset?.etag).toBe("etag_1");
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
						key: audioAsset.uploadStagingR2Key ?? audioAssetR2Key,
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
		r2Objects.set(asset.uploadStagingR2Key ?? assetR2Key, new TextEncoder().encode(markdownContent));

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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
		r2Objects.set(
			asset.uploadStagingR2Key ?? assetR2Key,
			new TextEncoder().encode("\uFEFFkey: value\r\nother: 2\r\n"),
		);

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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
		r2Objects.set(asset.uploadStagingR2Key ?? assetR2Key, new TextEncoder().encode(overCapMarkdown));

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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
		r2Objects.set(asset.uploadStagingR2Key ?? assetR2Key, new TextEncoder().encode(valuesOverCapMarkdown));

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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
		r2Objects.set(asset.uploadStagingR2Key ?? assetR2Key, new Uint8Array([0x48, 0xff, 0xfe]));

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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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
						key: asset.uploadStagingR2Key ?? assetR2Key,
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

	test("hands expired unreferenced assets to the deletion ledger and keeps unexpired ones", async () => {
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const expiredAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now - 1 });
		const unexpiredAssetId = await seed_unfinalized_asset(t, { ...db, unfinalizedExpiresAt: now + DAY_MS });
		const expiredKey = expected_asset_key({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: expiredAssetId,
		});
		// Bytes can exist even without r2Key: the PUT can land without its event ever reaching us.
		r2Objects.set(expiredKey, new TextEncoder().encode("orphan-bytes"));

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		const [expiredAsset, unexpiredAsset] = await t.run(async (ctx) =>
			Promise.all([ctx.db.get("files_r2_assets", expiredAssetId), ctx.db.get("files_r2_assets", unexpiredAssetId)]),
		);
		expect(swept).toEqual({ deletedCount: 1, done: true });
		expect(expiredAsset).toBeNull();
		expect(unexpiredAsset?.unfinalizedExpiresAt).toBe(now + DAY_MS);
		// The exact-key deletion job owns these bytes. The component's limited retry helper is not used.
		const job = await get_deletion_job_by_key(t, expiredKey);
		expect(job).toMatchObject({ reason: "untracked_asset_event", generation: 1 });
		expect(deleteObjectSpy).not.toHaveBeenCalled();
		await flush_scheduled(t);
		expect(r2Objects.has(expiredKey)).toBe(false);
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

			const [firstAsset, secondAsset, jobs] = await t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", firstAssetId),
					ctx.db.get("files_r2_assets", secondAssetId),
					ctx.db.query("files_r2_object_deletion_jobs").collect(),
				]),
			);
			expect(firstAsset).toBeNull();
			expect(secondAsset).toBeNull();
			// Each object received its own deletion job instead of using the limited retry helper.
			expect(jobs).toHaveLength(2);
			expect(confirmedDeleteSpy).toHaveBeenCalledTimes(2);
			expect(deleteObjectSpy).not.toHaveBeenCalled();
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

	test("recovers a referenced upload after event retries were exhausted", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "sweeper-recovery.png");
		const liveBytes = new TextEncoder().encode("copied-before-crash");
		r2Objects.set(upload.liveKey, liveBytes);
		r2ObjectMetadata.set(upload.liveKey, { size: liveBytes.byteLength, etag: "etag_copied_before_crash" });
		const now = Date.now();
		await t.run(async (ctx) =>
			ctx.db.patch("files_r2_assets", upload.assetId, {
				unfinalizedExpiresAt: now - 1,
			}),
		);

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept).toEqual({ deletedCount: 0, done: true });
		await flush_scheduled(t);

		expect(r2_text(upload.liveKey)).toBe("copied-before-crash");
		const recoveredAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect(recoveredAsset).toMatchObject({
			r2Key: upload.liveKey,
			size: liveBytes.byteLength,
			etag: "etag_copied_before_crash",
			processingWorkId: null,
		});
		expect(recoveredAsset?.unfinalizedExpiresAt).toBeUndefined();
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({
			reason: "upload_staging",
			lastR2EventId: `upload_recovery_${upload.assetId}`,
		});
	});

	test("heals a referenced finalized asset that kept a stale deadline instead of deleting it", async () => {
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const driftedAssetId = await seed_unfinalized_asset(t, {
			...db,
			r2Key: "test/finalized-with-stale-deadline",
			unfinalizedExpiresAt: now - 1,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "drifted.pdf",
				kind: "file",
				path: "/drifted.pdf",
				treePath: "/drifted.pdf",
				assetId: driftedAssetId,
			});
		});

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		const driftedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", driftedAssetId));
		expect(swept.deletedCount).toBe(0);
		expect(driftedAsset).not.toBeNull();
		expect(driftedAsset?.unfinalizedExpiresAt).toBeUndefined();
		expect(deleteObjectSpy).not.toHaveBeenCalled();
		expect(confirmedDeleteSpy).not.toHaveBeenCalled();
		expect(await get_deletion_job_by_key(t, "test/finalized-with-stale-deadline")).toBeNull();
	});

	test("hands an expired unreferenced asset with a confirmed object to the ledger before deleting the doc", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		// Expired long enough ago that the derived arrival window is already closed, so the job can
		// settle fully on its first confirmed delete.
		const orphanAssetId = await seed_unfinalized_asset(t, {
			...db,
			r2Key: "test/confirmed-orphan",
			unfinalizedExpiresAt: now - 10 * 60 * 1000,
		});
		r2Objects.set("test/confirmed-orphan", new TextEncoder().encode("confirmed-orphan-bytes"));

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		expect(swept.deletedCount).toBe(1);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", orphanAssetId))).toBeNull();
		await flush_scheduled(t);
		expect(r2Objects.has("test/confirmed-orphan")).toBe(false);
		// Post-window confirmed success settles the job completely.
		expect(await get_deletion_job_by_key(t, "test/confirmed-orphan")).toBeNull();
	});

	test("keeps the deadline when the event confirms bytes for a node-less upload and later hands them to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "node-less.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		// The node is hard-deleted before the PUT's event arrives.
		await t.run(async (ctx) => ctx.db.delete("files_nodes", upload.nodeId));
		r2Objects.set(upload.key, new TextEncoder().encode("node-less-bytes"));

		const response = await post_r2_put_event(t, {
			bucket,
			key: upload.key,
			size: 16,
			messageId: "message_node_less_put",
		});
		expect(response.status).toBe(204);

		// Event confirmation records the key but must NOT clear the deadline: there is no durable
		// live reference, so the asset is not published.
		const confirmedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect(confirmedAsset?.r2Key).toBe(upload.liveKey);
		expect(confirmedAsset?.unfinalizedExpiresAt).toEqual(expect.any(Number));

		// The expired sweep hands the exact key to the durable ledger and deletes the asset doc.
		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: (confirmedAsset?.unfinalizedExpiresAt ?? 0) + 1,
		});
		expect(swept.deletedCount).toBe(1);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId))).toBeNull();
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({ reason: "upload_staging" });
		expect(await get_deletion_job_by_key(t, upload.liveKey)).toMatchObject({ reason: "untracked_asset_event" });
		await flush_scheduled(t);
		expect(r2Objects.has(upload.key)).toBe(false);
		expect(r2Objects.has(upload.liveKey)).toBe(false);
	});

	test("staging cleanup never clears the orphan deadline for a node-less published upload", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "node-less-cleanup.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		await t.run(async (ctx) => ctx.db.delete("files_nodes", upload.nodeId));
		r2Objects.set(upload.key, new TextEncoder().encode("orphan-bytes"));
		expect(
			(
				await post_r2_put_event(t, {
					bucket,
					key: upload.key,
					size: 12,
					messageId: "message_node_less_cleanup",
				})
			).status,
		).toBe(204);

		const beforeCleanup = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		const stagingJob = await get_deletion_job_by_key(t, upload.key);
		if (!stagingJob?.putMayArriveUntil) {
			throw new Error("Expected staging cleanup tombstone");
		}
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: stagingJob._id,
			generation: stagingJob.generation,
			deletedAt: stagingJob.putMayArriveUntil + 1,
		});

		const afterCleanup = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect(afterCleanup?.r2Key).toBe(upload.liveKey);
		expect(afterCleanup?.unfinalizedExpiresAt).toBe(beforeCleanup?.unfinalizedExpiresAt);
	});

	test("keeps the finite delete path for reserved-scope assets", async () => {
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const t = test_convex();
		const now = Date.now();
		const reservedAssetId = await t.run(async (ctx) =>
			ctx.db.insert("files_r2_assets", {
				organizationId: organizations_GLOBAL_ORGANIZATION_ID,
				workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
				kind: "content",
				r2Bucket: "test-bucket",
				size: 64,
				createdBy: users_SYSTEM_AUTHOR,
				unfinalizedExpiresAt: now - 1,
				updatedAt: now,
			}),
		);

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: now });

		// Deletion jobs need real tenant ids, so reserved workspaces keep the old limited retry helper.
		expect(swept.deletedCount).toBe(1);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", reservedAssetId))).toBeNull();
		expect(deleteObjectSpy).toHaveBeenCalledWith(
			expect.anything(),
			`organizations/${organizations_GLOBAL_ORGANIZATION_ID}/workspaces/${organizations_GLOBAL_GITHUB_WORKSPACE_ID}/assets/${reservedAssetId}`,
		);
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toHaveLength(0);
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
						key:
							pending?.uploadStagingR2Key ??
							expected_asset_key({
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

describe("content pipeline crash orphans", () => {
	test("a crashed create leaves both snapshot assets deadlined, unpublished by their events, and swept to the ledger", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

			// Do exactly what the create action does up to its PUTs: two unfinalized assets and both
			// objects at their deterministic keys. The simulated crash means the atomic
			// create_file_node publication never runs.
			const yjsSnapshotAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				size: 24,
				createdBy: db.userId,
			});
			const versionSnapshotAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				size: 16,
				createdBy: db.userId,
			});
			const yjsKey = expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: yjsSnapshotAssetId,
			});
			const versionKey = expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: versionSnapshotAssetId,
			});
			r2Objects.set(yjsKey, new TextEncoder().encode("crashed-yjs-bytes"));
			r2Objects.set(versionKey, new TextEncoder().encode("# crashed create"));

			// The crash left both docs unreferenced, with deadlines and no r2Key.
			const [yjsAsset, versionAsset] = await t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", yjsSnapshotAssetId),
					ctx.db.get("files_r2_assets", versionSnapshotAssetId),
				]),
			);
			expect(yjsAsset?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());
			expect(versionAsset?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());
			expect(yjsAsset?.r2Key).toBeUndefined();
			expect(versionAsset?.r2Key).toBeUndefined();

			// The PUT events still arrive. The route acknowledges generated-object events without
			// touching the docs — action-side finalization is the only publisher for these kinds —
			// so the confirmations must NOT clear the deadlines or set r2Key.
			const bucket = yjsAsset?.r2Bucket ?? "";
			expect(
				(await post_r2_put_event(t, { bucket, key: yjsKey, size: 24, messageId: "message_create_crash_yjs" }))
					.status,
			).toBe(204);
			expect(
				(await post_r2_put_event(t, { bucket, key: versionKey, size: 16, messageId: "message_create_crash_version" }))
					.status,
			).toBe(204);
			const [confirmedYjs, confirmedVersion] = await t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", yjsSnapshotAssetId),
					ctx.db.get("files_r2_assets", versionSnapshotAssetId),
				]),
			);
			expect(confirmedYjs?.r2Key).toBeUndefined();
			expect(confirmedYjs?.unfinalizedExpiresAt).toEqual(expect.any(Number));
			expect(confirmedVersion?.r2Key).toBeUndefined();
			expect(confirmedVersion?.unfinalizedExpiresAt).toEqual(expect.any(Number));

			// The expired sweep deletes both docs and hands the exact keys to durable jobs.
			const testNow =
				Math.max(confirmedYjs?.unfinalizedExpiresAt ?? 0, confirmedVersion?.unfinalizedExpiresAt ?? 0) + 1;
			const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: testNow });
			expect(swept.deletedCount).toBe(2);
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", yjsSnapshotAssetId))).toBeNull();
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", versionSnapshotAssetId))).toBeNull();
			expect(await get_deletion_job_by_key(t, yjsKey)).toMatchObject({ reason: "untracked_asset_event" });
			expect(await get_deletion_job_by_key(t, versionKey)).toMatchObject({ reason: "untracked_asset_event" });

			// The durable jobs delete the bytes; a settled job row disappears.
			await flush_scheduled(t);
			expect(r2Objects.has(yjsKey)).toBe(false);
			expect(r2Objects.has(versionKey)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a restore crash after one PUT sweeps both staged snapshots and never touches the file's committed asset", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

			// A finalized file whose committed content asset is referenced by the node.
			const { committedAssetId, committedKey } = await t.run(async (ctx) => {
				const committedAssetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					r2Key: "test/restore-committed",
					size: 32,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: files_ROOT_ID,
					name: "restore-target.md",
					kind: "file",
					path: "/restore-target.md",
					treePath: "/restore-target.md",
					assetId: committedAssetId,
				});
				return { committedAssetId, committedKey: "test/restore-committed" };
			});
			r2Objects.set(committedKey, new TextEncoder().encode("committed-bytes"));

			// Do what the restore action does up to its PUTs: two content_snapshot assets (backup of
			// the current state + restored content). The crash lands mid-PUTs: only the backup's
			// bytes reached R2, and restore_snapshot never runs, so no files_snapshots row exists.
			const currentSnapshotAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				size: 32,
				createdBy: db.userId,
			});
			const restoredSnapshotAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				size: 48,
				createdBy: db.userId,
			});
			const currentKey = expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: currentSnapshotAssetId,
			});
			const restoredKey = expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: restoredSnapshotAssetId,
			});
			r2Objects.set(currentKey, new TextEncoder().encode("backup-bytes"));

			const [currentAsset, restoredAsset] = await t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", currentSnapshotAssetId),
					ctx.db.get("files_r2_assets", restoredSnapshotAssetId),
				]),
			);
			expect(currentAsset?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());
			expect(restoredAsset?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());

			// The sweep hands BOTH exact keys to durable jobs — also the one whose PUT never
			// happened, because only its job's confirmed delete can prove the bytes are absent.
			const testNow =
				Math.max(currentAsset?.unfinalizedExpiresAt ?? 0, restoredAsset?.unfinalizedExpiresAt ?? 0) + 1;
			const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: testNow });
			expect(swept.deletedCount).toBe(2);
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", currentSnapshotAssetId))).toBeNull();
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", restoredSnapshotAssetId))).toBeNull();
			expect(await get_deletion_job_by_key(t, currentKey)).toMatchObject({ reason: "untracked_asset_event" });
			expect(await get_deletion_job_by_key(t, restoredKey)).toMatchObject({ reason: "untracked_asset_event" });

			// Also prove the same cleanup ignores the node's committed asset. It has no deadline, so
			// its key has no job and its doc and bytes stay unchanged.
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", committedAssetId))).not.toBeNull();
			expect(await get_deletion_job_by_key(t, committedKey)).toBeNull();

			await flush_scheduled(t);
			expect(r2Objects.has(currentKey)).toBe(false);
			expect(r2Objects.has(committedKey)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a repair crash sweeps the fresh replacement assets while the superseded referenced snapshots survive", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

			// A file whose current Yjs snapshot and committed content are referenced (yjs snapshot
			// doc + node.assetId), like a repair target right before finalize_file_yjs_repair.
			const seeded = await t.run(async (ctx) => {
				const now = Date.now();
				const committedAssetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					r2Key: "test/repair-committed",
					size: 40,
					createdBy: db.userId,
					updatedAt: now,
				});
				const oldYjsAssetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-bucket",
					r2Key: "test/repair-old-yjs",
					size: 20,
					createdBy: db.userId,
					updatedAt: now,
				});
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: files_ROOT_ID,
					name: "repair-target.md",
					kind: "file",
					path: "/repair-target.md",
					treePath: "/repair-target.md",
					assetId: committedAssetId,
				});
				await ctx.db.insert("files_yjs_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					sequence: 3,
					assetId: oldYjsAssetId,
					createdBy: db.userId,
					updatedBy: db.userId,
					updatedAt: now,
				});
				return { committedAssetId, oldYjsAssetId };
			});

			// Do what the repair action does up to its PUTs: fresh replacement yjs_snapshot and
			// content_snapshot assets with both objects written. The crash means
			// finalize_file_yjs_repair never runs, so nothing references the fresh assets.
			const freshYjsAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				size: 22,
				createdBy: db.userId,
			});
			const freshContentAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				size: 44,
				createdBy: db.userId,
			});
			const freshYjsKey = expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: freshYjsAssetId,
			});
			const freshContentKey = expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: freshContentAssetId,
			});
			r2Objects.set(freshYjsKey, new TextEncoder().encode("fresh-yjs-bytes"));
			r2Objects.set(freshContentKey, new TextEncoder().encode("# repaired text"));

			// The PUT events are acknowledged but publish nothing: the route ignores generated-object
			// kinds, so the fresh assets keep their deadlines.
			const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", freshYjsAssetId))?.r2Bucket ?? "");
			expect(
				(await post_r2_put_event(t, { bucket, key: freshYjsKey, size: 22, messageId: "message_repair_crash_yjs" }))
					.status,
			).toBe(204);
			expect(
				(
					await post_r2_put_event(t, {
						bucket,
						key: freshContentKey,
						size: 44,
						messageId: "message_repair_crash_content",
					})
				).status,
			).toBe(204);
			const [confirmedFreshYjs, confirmedFreshContent] = await t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", freshYjsAssetId),
					ctx.db.get("files_r2_assets", freshContentAssetId),
				]),
			);
			expect(confirmedFreshYjs?.unfinalizedExpiresAt).toEqual(expect.any(Number));
			expect(confirmedFreshContent?.unfinalizedExpiresAt).toEqual(expect.any(Number));

			const testNow =
				Math.max(confirmedFreshYjs?.unfinalizedExpiresAt ?? 0, confirmedFreshContent?.unfinalizedExpiresAt ?? 0) + 1;
			const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: testNow });
			expect(swept.deletedCount).toBe(2);
			expect(await get_deletion_job_by_key(t, freshYjsKey)).toMatchObject({ reason: "untracked_asset_event" });
			expect(await get_deletion_job_by_key(t, freshContentKey)).toMatchObject({ reason: "untracked_asset_event" });

			// Also prove the same cleanup keeps old snapshots that are still in use.
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", seeded.committedAssetId))).not.toBeNull();
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", seeded.oldYjsAssetId))).not.toBeNull();
			expect(await get_deletion_job_by_key(t, "test/repair-committed")).toBeNull();
			expect(await get_deletion_job_by_key(t, "test/repair-old-yjs")).toBeNull();

			await flush_scheduled(t);
			expect(r2Objects.has(freshYjsKey)).toBe(false);
			expect(r2Objects.has(freshContentKey)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a completed create publishes both assets with references and stays invisible to a far-future sweep", async () => {
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
			path: "/published-create.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const published = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			const versionAsset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			const yjsSnapshotDoc = node?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId) : null;
			const yjsAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			const versionSnapshotDoc = versionAsset
				? await ctx.db
						.query("files_snapshots")
						.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
							q
								.eq("organizationId", db.organizationId)
								.eq("workspaceId", db.workspaceId)
								.eq("fileNodeId", node!._id),
						)
						.first()
				: null;
			return { node, versionAsset, yjsAsset, versionSnapshotDoc };
		});

		// Publication set both r2Keys and cleared both deadlines in the same final mutations that
		// created the live references (node.assetId, yjs snapshot doc, files_snapshots row).
		expect(published.versionAsset?.r2Key).toBe(
			expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: published.versionAsset?._id ?? "",
			}),
		);
		expect(published.versionAsset?.unfinalizedExpiresAt).toBeUndefined();
		expect(published.yjsAsset?.r2Key).toBe(
			expected_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: published.yjsAsset?._id ?? "",
			}),
		);
		expect(published.yjsAsset?.unfinalizedExpiresAt).toBeUndefined();
		expect(published.versionSnapshotDoc?.assetId).toBe(published.versionAsset?._id);

		// The sweeper angle: a far-future sweep has nothing to do with a published create.
		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: Date.now() + 365 * 24 * 60 * 60 * 1000,
		});
		expect(swept.deletedCount).toBe(0);
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toHaveLength(0);
	});
});

describe("process_uploaded_asset_event accepted upload", () => {
	test("ignores an old event after the signed staging key was overwritten", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "stale-event.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		const currentBytes = new TextEncoder().encode("current-version");
		r2Objects.set(upload.key, currentBytes);
		r2ObjectMetadata.set(upload.key, { size: currentBytes.byteLength, etag: "etag_current" });

		const staleResponse = await post_r2_put_event(t, {
			bucket,
			key: upload.key,
			size: 11,
			messageId: "message_stale",
			etag: "etag_stale",
			preserveObjectMetadata: true,
		});
		expect(staleResponse.status).toBe(204);
		expect(r2Objects.has(upload.liveKey)).toBe(false);
		expect((await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId)))?.r2Key).toBeUndefined();

		const currentResponse = await post_r2_put_event(t, {
			bucket,
			key: upload.key,
			size: currentBytes.byteLength,
			messageId: "message_current",
			etag: "etag_current",
			preserveObjectMetadata: true,
		});
		expect(currentResponse.status).toBe(204);
		expect(r2_text(upload.liveKey)).toBe("current-version");
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId))).toMatchObject({
			r2Key: upload.liveKey,
			size: currentBytes.byteLength,
			etag: "etag_current",
		});
	});

	test("publishes existing immutable bytes with their own metadata after a copy crash", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "copy-crash.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		const liveBytes = new TextEncoder().encode("immutable-first");
		const laterBytes = new TextEncoder().encode("later-staging-version");
		r2Objects.set(upload.liveKey, liveBytes);
		r2ObjectMetadata.set(upload.liveKey, { size: liveBytes.byteLength, etag: "etag_immutable_first" });
		r2Objects.set(upload.key, laterBytes);
		r2ObjectMetadata.set(upload.key, { size: laterBytes.byteLength, etag: "etag_later_staging" });

		const response = await post_r2_put_event(t, {
			bucket,
			key: upload.key,
			size: laterBytes.byteLength,
			messageId: "message_after_copy_crash",
			etag: "etag_later_staging",
			preserveObjectMetadata: true,
		});
		expect(response.status).toBe(204);

		expect(r2_text(upload.liveKey)).toBe("immutable-first");
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId))).toMatchObject({
			r2Key: upload.liveKey,
			size: liveBytes.byteLength,
			etag: "etag_immutable_first",
		});
	});

	test("keeps published bytes immutable after lock and a second PUT to the signed staging URL", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "immutable.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");

		r2Objects.set(upload.key, new TextEncoder().encode("first-version"));
		expect(
			(
				await post_r2_put_event(t, {
					bucket,
					key: upload.key,
					size: 13,
					messageId: "message_first_publish",
				})
			).status,
		).toBe(204);
		expect(r2_text(upload.liveKey)).toBe("first-version");

		await t.run(async (ctx) =>
			ctx.db.patch("files_nodes", upload.nodeId, {
				readOnlyScopeNodeId: upload.nodeId,
			}),
		);
		r2Objects.set(upload.key, new TextEncoder().encode("late-version"));
		expect(
			(
				await post_r2_put_event(t, {
					bucket,
					key: upload.key,
					size: 12,
					messageId: "message_late_put",
				})
			).status,
		).toBe(204);

		// A CopyObject notification for the live key is derived output. It must be ignored too.
		const liveEventResponse = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "message_live_copy",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket,
					object: { key: upload.liveKey, size: 13, eTag: "etag_live_copy" },
					eventTime: "2026-05-11T00:02:00.000Z",
				},
			}),
		});
		expect(liveEventResponse.status).toBe(204);

		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect(asset).toMatchObject({
			r2Key: upload.liveKey,
			etag: "etag_message_first_publish",
		});
		expect(r2_text(upload.liveKey)).toBe("first-version");
		expect(r2_text(upload.key)).toBe("late-version");
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({
			reason: "upload_staging",
			lastR2EventId: "message_late_put",
		});
		expect(await get_deletion_job_by_key(t, upload.liveKey)).toBeNull();
	});

	test("finishes an accepted upload after the node becomes read-only", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "image",
			displayName: "Image",
			description: "Image markdown generation",
			contentTypes: ["image/png"],
		});
		const locked = await create_upload_fixture(t, db, "locked.png");
		const control = await create_upload_fixture(t, db, "control.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", locked.assetId))?.r2Bucket ?? "");

		// The scope locks after the signed PUT target was minted, before its event arrives.
		await t.run(async (ctx) =>
			ctx.db.patch("files_nodes", locked.nodeId, { readOnlyScopeNodeId: locked.nodeId }),
		);
		r2Objects.set(locked.key, new TextEncoder().encode("locked-bytes"));
		r2Objects.set(control.key, new TextEncoder().encode("control-bytes"));

		const lockedResponse = await post_r2_put_event(t, {
			bucket,
			key: locked.key,
			size: 12,
			messageId: "message_locked_put",
		});
		const controlResponse = await post_r2_put_event(t, {
			bucket,
			key: control.key,
			size: 13,
			messageId: "message_control_put",
		});
		expect(lockedResponse.status).toBe(204);
		expect(controlResponse.status).toBe(204);
		await flush_scheduled(t);

		const [lockedAsset, controlAsset, lockedNode] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get("files_r2_assets", locked.assetId),
				ctx.db.get("files_r2_assets", control.assetId),
				ctx.db.get("files_nodes", locked.nodeId),
			]),
		);
		// The node was already created, so the accepted upload publishes like its unlocked sibling.
		expect(lockedAsset?.r2Key).toBe(locked.liveKey);
		expect(lockedAsset?.processingWorkId).toBeNull();
		expect(lockedAsset?.unfinalizedExpiresAt).toBeUndefined();
		// Publication does not change the lock or replace the node.
		expect(lockedNode?.archiveOperationId).toBeUndefined();
		expect(lockedNode?.assetId).toBe(locked.assetId);
		expect(lockedNode?.readOnlyScopeNodeId).toBe(locked.nodeId);
		expect(controlAsset?.r2Key).toBe(control.liveKey);
		expect(controlAsset?.unfinalizedExpiresAt).toBeUndefined();

		// Only the mutable staging key is cleaned. The immutable live key stays published.
		const job = await get_deletion_job_by_key(t, locked.key);
		expect(job).toMatchObject({
			reason: "upload_staging",
			generation: 1,
			lastR2EventId: "message_locked_put",
		});
		expect(job?.putMayArriveUntil).toBe(
			(lockedAsset?.uploadUrlExpiresAt ?? 0) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
		);
		expect(job?.nextAttemptAt).toBe(job?.putMayArriveUntil);
		expect(r2Objects.has(locked.key)).toBe(false);
		expect(r2Objects.has(locked.liveKey)).toBe(true);
		expect(r2Objects.has(control.liveKey)).toBe(true);

		// Upload-completed plugins are part of finishing the accepted upload. Their own output
		// writes still pass the normal destination lock checks.
		const [lockedRuns, controlRuns] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("plugins_event_runs")
					.withIndex("by_asset_event_installation", (q) =>
						q.eq("assetId", locked.assetId).eq("event", "files.upload.completed"),
					)
					.collect(),
				ctx.db
					.query("plugins_event_runs")
					.withIndex("by_asset_event_installation", (q) =>
						q.eq("assetId", control.assetId).eq("event", "files.upload.completed"),
					)
					.collect(),
			]),
		);
		expect(lockedRuns).toHaveLength(1);
		expect(controlRuns).toHaveLength(1);
	});

	test("finishes after a lock and unlock before upload publication", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "lock-cycle.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");

		// Locking and then unlocking after acceptance does not cancel this upload.
		r2Objects.set(upload.key, new TextEncoder().encode("lock-cycle-bytes"));

		const response = await post_r2_put_event(t, {
			bucket,
			key: upload.key,
			size: 15,
			messageId: "message_lock_cycle_put",
		});
		expect(response.status).toBe(204);
		await flush_scheduled(t);

		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect(asset?.r2Key).toBe(upload.liveKey);
		expect(asset?.unfinalizedExpiresAt).toBeUndefined();
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({ reason: "upload_staging", generation: 1 });
		expect(r2Objects.has(upload.key)).toBe(false);
		expect(r2Objects.has(upload.liveKey)).toBe(true);
	});

	test("advances the job generation per distinct event and recreates a settled job", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "redelivered.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		const post_event = async (messageId: string) => {
			r2Objects.set(upload.key, new TextEncoder().encode(`bytes-${messageId}`));
			const response = await post_r2_put_event(t, { bucket, key: upload.key, size: 10, messageId });
			expect(response.status).toBe(204);
			await flush_scheduled(t);
		};

		await post_event("message_d_1");
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({
			generation: 1,
			lastR2EventId: "message_d_1",
		});

		// Redelivery of the same event id is an idempotent duplicate.
		await post_event("message_d_1");
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({
			generation: 1,
			lastR2EventId: "message_d_1",
		});

		// A different event id means another upload reached the key. Increase the generation so an
		// older delete cannot remove the job for the newer bytes.
		await post_event("message_d_2");
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({
			generation: 2,
			lastR2EventId: "message_d_2",
		});

		// After the staging job fully settles, a third PUT recreates it.
		await t.run(async (ctx) => {
			const job = await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", upload.key))
				.first();
			if (job) {
				await ctx.db.delete("files_r2_object_deletion_jobs", job._id);
			}
		});
		await post_event("message_d_3");
		expect(await get_deletion_job_by_key(t, upload.key)).toMatchObject({
			generation: 1,
			lastR2EventId: "message_d_3",
		});

		// One live job per exact key, always.
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", upload.key))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});
});

describe("finalize_uploaded_text_file accepted upload", () => {
	async function confirm_upload_put(
		t: ReturnType<typeof test_convex>,
		upload: { assetId: Id<"files_r2_assets">; key: string },
		content: string,
		messageId: string,
	) {
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		r2Objects.set(upload.key, new TextEncoder().encode(content));
		const response = await post_r2_put_event(t, { bucket, key: upload.key, size: 1024, messageId });
		expect(response.status).toBe(204);
	}

	/**
	 * Run the conversion action while a read-only state change lands during its derived R2 PUTs.
	 */
	async function run_conversion_with_mid_put_change(
		t: ReturnType<typeof test_convex>,
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
		upload: { assetId: Id<"files_r2_assets"> },
		applyChange: () => Promise<void>,
	) {
		let changeApplied = false;
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
			if (!changeApplied) {
				changeApplied = true;
				await applyChange();
			}
			return { key: customKey ?? "test-upload-key", url: r2_url("upload", customKey ?? "test-upload-key") };
		});

		await t.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload.assetId,
			eventId: `event_${upload.assetId}`,
		});
		expect(changeApplied).toBe(true);
	}

	test("converts an accepted text upload after the node becomes read-only", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		// The lock lands between the event and the conversion action run.
		const locked = await create_upload_fixture(t, db, "locked.md", "text/markdown;charset=utf-8");
		await confirm_upload_put(t, locked, "# Locked\n\nbody", "message_locked_md");
		await t.run(async (ctx) =>
			ctx.db.patch("files_nodes", locked.nodeId, { readOnlyScopeNodeId: locked.nodeId }),
		);
		await t.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: locked.assetId,
			eventId: "event_locked_md",
		});

		const docs = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", locked.nodeId);
			const asset = await ctx.db.get("files_r2_assets", locked.assetId);
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			return { node, asset, jobs };
		});
		// Conversion is part of the accepted upload. The node becomes editable and stays locked.
		expect(docs.node?.assetId).not.toBe(locked.assetId);
		expect(docs.node?.yjsSnapshotId).toEqual(expect.any(String));
		expect(docs.node?.yjsLastSequenceId).toEqual(expect.any(String));
		expect(docs.node?.yjsRootKind).toBe("rich_text");
		expect(docs.node?.readOnlyScopeNodeId).toBe(locked.nodeId);
		expect(docs.asset?.processingWorkId).toBeNull();
		expect(docs.asset?.r2Key).toBe(locked.liveKey);
		expect(r2Objects.has(locked.liveKey)).toBe(true);
		// Only normal staging cleanup remains.
		expect(docs.jobs).toHaveLength(1);
		expect(docs.jobs.find((job) => job.r2Key === locked.key)).toMatchObject({ reason: "upload_staging" });
	});

	test("dispatches the fallback plugin when the node locks during the accepted upload", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await install_upload_plugin(t, {
			userId: db.userId,
			membershipId: db.membershipId,
			name: "pdf",
			displayName: "JSON watcher",
			description: "Watches JSON uploads",
			contentTypes: ["application/json"],
		});
		const upload = await create_upload_fixture(t, db, "mid-lock.json", "application/json");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		r2Objects.set(upload.key, new Uint8Array([0x48, 0xff, 0xfe]));
		expect(
			(
				await post_r2_put_event(t, {
					bucket,
					key: upload.key,
					size: 3,
					messageId: "message_fallback_mid_lock",
				})
			).status,
		).toBe(204);

		const fetchMock = vi.mocked(fetch);
		const fetchImplementation = fetchMock.getMockImplementation();
		if (!fetchImplementation) {
			throw new Error("Expected R2 fetch mock");
		}
		let lockApplied = false;
		fetchMock.mockImplementation(async (input, init) => {
			const response = await fetchImplementation(input, init);
			if (!lockApplied && String(input) === r2_url("object", upload.liveKey)) {
				lockApplied = true;
				await t.run(async (ctx) =>
					ctx.db.patch("files_nodes", upload.nodeId, {
						readOnlyScopeNodeId: upload.nodeId,
					}),
				);
			}
			return response;
		});

		await t.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: upload.assetId,
			eventId: "event_fallback_mid_lock",
		});
		expect(lockApplied).toBe(true);

		const settled = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", upload.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload.assetId);
			const pluginRuns = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_asset_event_installation", (q) =>
					q.eq("assetId", upload.assetId).eq("event", "files.upload.completed"),
				)
				.collect();
			return { node, asset, pluginRuns };
		});
		expect(settled.node?.yjsSnapshotId).toBeUndefined();
		expect(settled.asset?.processingWorkId).toBeNull();
		expect(settled.pluginRuns).toHaveLength(1);
	});

	test("finishes when the node locks during conversion", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "mid-lock.md", "text/markdown;charset=utf-8");
		await confirm_upload_put(t, upload, "# Mid lock\n\nbody", "message_mid_lock_md");

		await run_conversion_with_mid_put_change(t, db, upload, async () => {
			await t.run(async (ctx) => {
				await ctx.db.patch("files_nodes", upload.nodeId, {
					readOnlyScopeNodeId: upload.nodeId,
				});
			});
		});

		const published = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", upload.nodeId),
			sourceAsset: await ctx.db.get("files_r2_assets", upload.assetId),
			assets: await ctx.db.query("files_r2_assets").collect(),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
			yjsSnapshots: await ctx.db.query("files_yjs_snapshots").collect(),
			snapshots: await ctx.db.query("files_snapshots").collect(),
			chunks: await ctx.db.query("files_text_chunks").collect(),
		}));
		expect(published.node?.assetId).not.toBe(upload.assetId);
		expect(published.node?.yjsSnapshotId).toEqual(expect.any(String));
		expect(published.node?.yjsLastSequenceId).toEqual(expect.any(String));
		expect(published.node?.yjsRootKind).toBe("rich_text");
		expect(published.node?.readOnlyScopeNodeId).toBe(upload.nodeId);
		expect(published.sourceAsset?.processingWorkId).toBeNull();
		expect(published.sourceAsset?.r2Key).toBe(upload.liveKey);
		expect(published.assets).toHaveLength(3);
		expect(published.yjsSnapshots).toHaveLength(1);
		expect(published.snapshots).toHaveLength(1);
		expect(published.chunks.length).toBeGreaterThan(0);
		expect(published.jobs).toEqual([
			expect.objectContaining({ r2Key: upload.key, reason: "upload_staging" }),
		]);
	});

	test("finishes after a lock and unlock during conversion", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const upload = await create_upload_fixture(t, db, "lock-cycle.md", "text/markdown;charset=utf-8");
		await confirm_upload_put(t, upload, "# Lock cycle\n\nbody", "message_lock_cycle_md");

		await run_conversion_with_mid_put_change(t, db, upload, async () => {});

		const published = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", upload.nodeId),
			sourceAsset: await ctx.db.get("files_r2_assets", upload.assetId),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
		}));
		expect(published.node?.yjsSnapshotId).toEqual(expect.any(String));
		expect(published.node?.yjsRootKind).toBe("rich_text");
		expect(published.sourceAsset?.processingWorkId).toBeNull();
		expect(published.jobs).toEqual([
			expect.objectContaining({ r2Key: upload.key, reason: "upload_staging" }),
		]);
	});
});

describe("materialize_file_content on a locked node", () => {
	test("materializes a pre-lock committed Yjs update after the node locks", async () => {
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
			path: "locked-materialize.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const assets = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!node?.yjsSnapshotId) {
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

		const updatedMarkdown = "# Locked materialize\n\nCommitted before the lock.\n";
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
			sessionId: "locked-materialize-session",
		});
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}

		// The node locks after the update committed. A committed update is already accepted
		// content, so materialization is derived completion and must NOT be gated by the lock.
		await t.run(async (ctx) =>
			ctx.db.patch("files_nodes", created._yay.nodeId, {
				readOnlyScopeNodeId: created._yay.nodeId,
			}),
		);

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: created._yay.nodeId,
			userId: db.userId,
			targetSequence: 1,
		});
		expect(materialized._nay).toBeUndefined();

		const snapshot = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			return node?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId) : null;
		});
		expect(snapshot?.sequence).toBe(1);
	});
});

describe("r2_enqueue_object_deletion_job", () => {
	test("keeps one live job per key across handoffs, events, and ensure calls", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		// Use a far-future final-delete time. Each scheduled delete keeps the job, so its fields remain
		// available for the checks below.
		const farFuture = Date.now() + 60 * 60 * 1000;
		const enqueue = async (args: {
			r2Key: string;
			putMayArriveUntil?: number;
			r2EventId?: string;
			mode?: "advance" | "ensure";
		}) => {
			await t.run(async (ctx) => {
				await r2_enqueue_object_deletion_job(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					reason: "read_only_create",
					...args,
				});
			});
		};

		await enqueue({ r2Key: "test/ledger-key", putMayArriveUntil: farFuture });
		expect(await get_deletion_job_by_key(t, "test/ledger-key")).toMatchObject({
			generation: 1,
			putMayArriveUntil: farFuture,
		});

		// A second handoff advances the generation and can only widen the window, never shorten it.
		await enqueue({ r2Key: "test/ledger-key", putMayArriveUntil: farFuture - 1000 });
		expect(await get_deletion_job_by_key(t, "test/ledger-key")).toMatchObject({
			generation: 2,
			putMayArriveUntil: farFuture,
		});

		// A distinct R2 event advances; duplicate delivery of the same event id is idempotent.
		await enqueue({ r2Key: "test/ledger-key", r2EventId: "evt_1" });
		expect(await get_deletion_job_by_key(t, "test/ledger-key")).toMatchObject({
			generation: 3,
			lastR2EventId: "evt_1",
		});
		await enqueue({ r2Key: "test/ledger-key", r2EventId: "evt_1" });
		expect(await get_deletion_job_by_key(t, "test/ledger-key")).toMatchObject({ generation: 3 });
		await enqueue({ r2Key: "test/ledger-key", r2EventId: "evt_2" });
		expect(await get_deletion_job_by_key(t, "test/ledger-key")).toMatchObject({
			generation: 4,
			lastR2EventId: "evt_2",
		});

		// "ensure" never advances an existing job but creates a missing one.
		await enqueue({ r2Key: "test/ledger-key", mode: "ensure" });
		expect(await get_deletion_job_by_key(t, "test/ledger-key")).toMatchObject({ generation: 4 });
		await enqueue({ r2Key: "test/ledger-other", mode: "ensure", putMayArriveUntil: farFuture });
		expect(await get_deletion_job_by_key(t, "test/ledger-other")).toMatchObject({ generation: 1 });

		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs).toHaveLength(2);
	});
});

describe("process_object_deletion_job", () => {
	test("keeps retrying a failing confirmed delete and settles fully when it recovers", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const upload = await create_upload_fixture(t, db, "durable.png");
			await t.run(async (ctx) =>
				ctx.db.patch("files_r2_assets", upload.assetId, {
					unfinalizedExpiresAt: Date.now() + 60_000,
				}),
			);
			r2Objects.set(upload.key, new TextEncoder().encode("durable-bytes"));
			confirmedDeleteSpy.mockRejectedValue(new Error("r2 down"));

			// Window already closed: the first confirmed success may settle fully.
			await t.run(async (ctx) => {
				await r2_enqueue_object_deletion_job(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					r2Key: upload.key,
					reason: "failed_create",
					assetId: upload.assetId,
					putMayArriveUntil: Date.now() - 1,
				});
			});

			for (let i = 0; i < 8; i += 1) {
				vi.advanceTimersByTime(20 * 60 * 1000);
				await t.finishInProgressScheduledFunctions();
			}

			// Failures never drop the job, the deadline, or the bytes.
			const failingJob = await get_deletion_job_by_key(t, upload.key);
			expect(failingJob?.attempts).toBeGreaterThanOrEqual(4);
			expect(r2Objects.has(upload.key)).toBe(true);
			expect(
				(await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId)))?.unfinalizedExpiresAt,
			).toEqual(expect.any(Number));

			// Recovery. Seed a component metadata row so the settle's deleteMetadata is observable.
			confirmedDeleteSpy.mockImplementation(async (_ctx, key: string) => {
				r2Objects.delete(key);
			});
			await t.run(async (ctx) =>
				ctx.runMutation(components.r2.lib.upsertMetadata, {
					key: upload.key,
					bucket: process.env.R2_BUCKET_FILES ?? "",
					lastModified: new Date().toISOString(),
					link: r2_url("object", upload.key),
				}),
			);

			for (let i = 0; i < 8; i += 1) {
				vi.advanceTimersByTime(60 * 60 * 1000);
				await t.finishInProgressScheduledFunctions();
			}

			expect(r2Objects.has(upload.key)).toBe(false);
			expect(await get_deletion_job_by_key(t, upload.key)).toBeNull();
			const settledAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
			// Post-expiry confirmed success clears the asset cleanup deadline.
			expect(settledAsset?.unfinalizedExpiresAt).toBeUndefined();
			// The settle removed the component metadata row: re-upserting reports a fresh insert.
			const reUpsert = await t.run(async (ctx) =>
				ctx.runMutation(components.r2.lib.upsertMetadata, {
					key: upload.key,
					bucket: process.env.R2_BUCKET_FILES ?? "",
					lastModified: new Date().toISOString(),
					link: r2_url("object", upload.key),
				}),
			);
			expect(reUpsert).toEqual({ isNew: true });
		} finally {
			vi.useRealTimers();
		}
	});

	test("a delete success raced by a newer PUT cannot settle the newer generation", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const upload = await create_upload_fixture(t, db, "raced.png");
			const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
			r2Objects.set(upload.key, new TextEncoder().encode("first-bytes"));
			const response = await post_r2_put_event(t, { bucket, key: upload.key, size: 11, messageId: "message_race_1" });
			expect(response.status).toBe(204);

			// While the first delete's success is still in flight, a second PUT lands and its event
			// advances the job generation.
			let raced = false;
			confirmedDeleteSpy.mockImplementation(async (_ctx, key: string) => {
				r2Objects.delete(key);
				if (!raced) {
					raced = true;
					r2Objects.set(upload.key, new TextEncoder().encode("late-bytes"));
					const raceResponse = await post_r2_put_event(t, {
						bucket,
						key: upload.key,
						size: 10,
						messageId: "message_race_2",
					});
					expect(raceResponse.status).toBe(204);
				}
			});

			for (let i = 0; i < 8; i += 1) {
				vi.advanceTimersByTime(1000);
				await t.finishInProgressScheduledFunctions();
			}

			// The stale success rescheduled instead of settling; the newer generation deleted the
			// late bytes and tombstoned at the window.
			const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
			const job = await get_deletion_job_by_key(t, upload.key);
			expect(raced).toBe(true);
			expect(job).toMatchObject({ generation: 2, lastR2EventId: "message_race_2" });
			expect(job?.putMayArriveUntil).toBe(
				(asset?.uploadUrlExpiresAt ?? 0) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
			);
			expect(job?.nextAttemptAt).toBe(job?.putMayArriveUntil);
			expect(r2Objects.has(upload.key)).toBe(false);
			expect(asset?.unfinalizedExpiresAt).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a tombstone wakes after the arrival window and removes a late PUT for good", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const upload = await create_upload_fixture(t, db, "tombstone.png");
			const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
			// Stamp the mint-time signed-url expiry the create door will provide; the window derives
			// from it.
			const mintedNow = Date.now();
			await t.run(async (ctx) => ctx.db.patch("files_r2_assets", upload.assetId, { uploadUrlExpiresAt: mintedNow + 60_000 }));
			r2Objects.set(upload.key, new TextEncoder().encode("tombstone-bytes"));
			const response = await post_r2_put_event(t, {
				bucket,
				key: upload.key,
				size: 15,
				messageId: "message_window_put",
			});
			expect(response.status).toBe(204);

			for (let i = 0; i < 5; i += 1) {
				vi.advanceTimersByTime(1000);
				await t.finishInProgressScheduledFunctions();
			}

			// R2 confirms deletion before another upload is impossible. Keep the job and run it again at
			// the final-delete time.
			const window = mintedNow + 60_000 + r2_PUT_MAY_ARRIVE_MARGIN_MS;
			const tombstone = await get_deletion_job_by_key(t, upload.key);
			expect(tombstone).toMatchObject({ generation: 1, putMayArriveUntil: window, nextAttemptAt: window });
			expect(r2Objects.has(upload.key)).toBe(false);

			// A late PUT through the still-signed URL lands and its event never arrives.
			r2Objects.set(upload.key, new TextEncoder().encode("late-put-bytes"));

			// The hourly cron picks the tombstone up once the window closed.
			const pastWindow = window + 1000;
			vi.setSystemTime(pastWindow);
			const paged = await t.mutation(internal.r2_client.schedule_due_object_deletion_jobs, {
				_test_now: pastWindow,
			});
			expect(paged.scheduledCount).toBe(1);
			for (let i = 0; i < 5; i += 1) {
				vi.advanceTimersByTime(1000);
				await t.finishInProgressScheduledFunctions();
			}

			expect(r2Objects.has(upload.key)).toBe(false);
			expect(await get_deletion_job_by_key(t, upload.key)).toBeNull();
			const settledAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
			expect(settledAsset?.unfinalizedExpiresAt).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a crash between the confirmed delete and settlement is repaired by the next attempt", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			r2Objects.set("test/crash-after-delete", new TextEncoder().encode("crash-bytes"));
			// First attempt: the delete reaches R2, then the action dies before it can settle.
			confirmedDeleteSpy.mockImplementationOnce(async (_ctx, key: string) => {
				r2Objects.delete(key);
				throw new Error("crashed after delete");
			});

			await t.run(async (ctx) => {
				await r2_enqueue_object_deletion_job(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					r2Key: "test/crash-after-delete",
					reason: "read_only_stage",
				});
			});

			vi.advanceTimersByTime(1000);
			await t.finishInProgressScheduledFunctions();
			const afterCrash = await get_deletion_job_by_key(t, "test/crash-after-delete");
			expect(afterCrash?.attempts).toBe(1);
			expect(r2Objects.has("test/crash-after-delete")).toBe(false);

			// R2 DELETE is idempotent: the retry confirms the delete again and settles.
			vi.advanceTimersByTime(31_000);
			await t.finishInProgressScheduledFunctions();
			vi.advanceTimersByTime(1000);
			await t.finishInProgressScheduledFunctions();
			expect(await get_deletion_job_by_key(t, "test/crash-after-delete")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	test("the due-job sweep drains a backlog above one page in bounded self-rescheduled pages", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		await t.run(async (ctx) => {
			// 51 due jobs with no scheduled processor: exactly the crash-recovery state the hourly
			// cron exists for.
			for (let i = 0; i < 51; i += 1) {
				await ctx.db.insert("files_r2_object_deletion_jobs", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					r2Key: `test/drain-${i}`,
					reason: "read_only_stage",
					generation: 1,
					attempts: 0,
					nextAttemptAt: now - 1,
				});
			}
		});

		const firstPage = await t.mutation(internal.r2_client.schedule_due_object_deletion_jobs, {});
		expect(firstPage).toEqual({ scheduledCount: 50, done: false });

		await flush_scheduled(t, 8);
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toHaveLength(0);
		expect(confirmedDeleteSpy).toHaveBeenCalledTimes(51);
	});
});

describe("record_untracked_asset_event", () => {
	test("hands a valid tenant key without an asset doc to the ledger and keeps 404 for garbage keys", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const abandoned = await create_upload_fixture(t, db, "abandoned.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", abandoned.assetId))?.r2Bucket ?? "");
		// Cleanup already removed the asset and node docs; the PUT's event arrives late.
		await t.run(async (ctx) => {
			await ctx.db.delete("files_nodes", abandoned.nodeId);
			await ctx.db.delete("files_r2_assets", abandoned.assetId);
		});
		r2Objects.set(abandoned.key, new TextEncoder().encode("abandoned-bytes"));

		const now = Date.now();
		const response = await post_r2_put_event(t, {
			bucket,
			key: abandoned.key,
			size: 15,
			messageId: "message_untracked_put",
		});
		expect(response.status).toBe(204);

		const job = await get_deletion_job_by_key(t, abandoned.key);
		expect(job).toMatchObject({
			reason: "untracked_asset_event",
			generation: 1,
			lastR2EventId: "message_untracked_put",
		});
		// The signed URL that produced this PUT can stay valid its full 15-minute life from now,
		// plus the margin.
		expect(job?.putMayArriveUntil).toBeGreaterThan(now + 19 * 60 * 1000);
		expect(job?.putMayArriveUntil).toBeLessThanOrEqual(now + 21 * 60 * 1000);

		await flush_scheduled(t);
		expect(r2Objects.has(abandoned.key)).toBe(false);
		// The window is still open, so the job stays as a tombstone.
		const tombstone = await get_deletion_job_by_key(t, abandoned.key);
		expect(tombstone?.nextAttemptAt).toBe(tombstone?.putMayArriveUntil);

		// Also prove a tracked upload uses the same route and publishes without a deletion job.
		const tracked = await create_upload_fixture(t, db, "tracked.png");
		r2Objects.set(tracked.key, new TextEncoder().encode("tracked-bytes"));
		const trackedResponse = await post_r2_put_event(t, {
			bucket,
			key: tracked.key,
			size: 13,
			messageId: "message_tracked_put",
		});
		expect(trackedResponse.status).toBe(204);
		expect((await t.run(async (ctx) => ctx.db.get("files_r2_assets", tracked.assetId)))?.r2Key).toBe(tracked.liveKey);
		expect(await get_deletion_job_by_key(t, tracked.key)).toMatchObject({ reason: "upload_staging" });

		// A key that is not a tenant asset key keeps answering 404.
		const garbageResponse = await post_r2_put_event(t, {
			bucket,
			key: "organizations/nope/workspaces/nope/assets/nope",
			size: 1,
			messageId: "message_garbage_put",
		});
		expect(garbageResponse.status).toBe(404);
	});
});

describe("get_asset", () => {
	test("returns the published asset after an accepted upload finishes under a lock", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await create_upload_fixture(t, db, "locked-query.png");
		const bucket = await t.run(async (ctx) => (await ctx.db.get("files_r2_assets", upload.assetId))?.r2Bucket ?? "");
		await t.run(async (ctx) =>
			ctx.db.patch("files_nodes", upload.nodeId, { readOnlyScopeNodeId: upload.nodeId }),
		);
		r2Objects.set(upload.key, new TextEncoder().encode("locked-bytes"));
		expect(
			(await post_r2_put_event(t, { bucket, key: upload.key, size: 12, messageId: "message_get_asset_locked" }))
				.status,
		).toBe(204);

		// The file view sees the normal published asset. The node remains locked separately.
		const [asset, node] = await Promise.all([
			asUser.query(api.r2.get_asset_by_file_node_id, { membershipId: db.membershipId, fileNodeId: upload.nodeId }),
			t.run(async (ctx) => ctx.db.get("files_nodes", upload.nodeId)),
		]);
		expect(asset?.r2Key).toBe(upload.liveKey);
		expect(asset?.unfinalizedExpiresAt).toBeUndefined();
		expect(node?.readOnlyScopeNodeId).toBe(upload.nodeId);
	});
});
