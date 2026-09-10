import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_get_file_yjs_pointers, test_mocks_fill_db_with } from "./setup.test.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_YJS_DOC_KEYS,
} from "../shared/files.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";

const objects = new Map<string, BodyInit>();

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_review" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	objects.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (url.pathname === "/upload" && init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

async function create_file_fixture(rootKind: "plain_text" | "rich_text" = "plain_text") {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const created = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		...scope,
		path: rootKind === "rich_text" ? "/restore.md" : "/restore.txt",
		textContent: "Original text\n",
	});
	if (created._nay) throw new Error(created._nay.message);
	const nodeId = created._yay.nodeId;
	const pointers = await test_get_file_yjs_pointers(t, nodeId);
	const snapshotId = await t.run(async (ctx) => {
		const snapshot = await ctx.db.query("files_snapshots").first();
		if (!snapshot) throw new Error("Missing created snapshot");
		return snapshot._id;
	});
	return { t, db, asUser, scope, nodeId, pointers, snapshotId };
}

async function create_pending_proposal(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	userId = fixture.scope.userId,
) {
	const { t, scope, nodeId } = fixture;
	const ownerScope = { ...scope, userId };
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		...ownerScope,
		nodeId,
	});
	if (batch._nay) throw new Error(batch._nay.message);
	for (const [role, text] of [
		["staged", "---\nreview: accepted\n---\n\nAccepted text\n"],
		["unstaged", "---\nreview: accepted\n---\n\nAccepted text\n\nProposed text\n"],
	] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...ownerScope,
			operationBatchId: batch._yay.operationBatchId,
			role,
			text,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const proposed = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...ownerScope,
		nodeId,
		operationBatchId: batch._yay.operationBatchId,
	});
	if (proposed._nay) throw new Error(proposed._nay.message);
	return await t.run(async (ctx) => {
		const pending = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_fileNode", (q) => q.eq("userId", userId).eq("fileNodeId", nodeId))
			.first();
		if (!pending) throw new Error("Missing pending proposal");
		return pending;
	});
}

async function expect_retired_uploads(t: ReturnType<typeof test_convex>, count: number) {
	await t.run(async (ctx) => {
		const assets = await ctx.db.query("files_r2_assets").collect();
		const publishedKeys = new Set(assets.map((asset) => asset.r2Key));
		const jobs = (await ctx.db.query("files_r2_object_deletion_jobs").collect()).filter(
			(job) => job.reason === "failed_create",
		);
		expect(jobs).toHaveLength(count);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			[...objects.keys()].filter((key) => !publishedKeys.has(key)).sort(),
		);
	});
}

describe("create_file_by_path", () => {
	test.each(["html", "htm"])("keeps %s source through saves, collaboration changes, and restore", async (extension) => {
		vi.useFakeTimers();
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const text = "<!doctype html>\n<html><head><title>Brief</title></head><body><p>Original</p></body></html>\n";
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			...scope,
			path: `/brief.${extension}`,
			textContent: text,
		});
		if (created._nay) throw new Error(created._nay.message);
		const nodeId = created._yay.nodeId;
		const snapshot = await t.run((ctx) => ctx.db.query("files_snapshots").first());
		if (!snapshot) throw new Error("Missing HTML snapshot");
		expect(snapshot).toMatchObject({ contentType: "text/html;charset=utf-8", yjsRootKind: "plain_text" });
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: text.replace("Original", "Saved"),
		});
		expect(saved._nay).toBeUndefined();
		expect(
			await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toEqual({ _yay: { text: text.replace("Original", "Saved"), textKind: "plain_text" } });
		for (const task of await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect())) {
			await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		}
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: snapshot._id,
			sessionId: "restore-html",
		});
		expect(restored._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			contentType: "text/html;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
		});
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: `/brief.${extension}`,
		});
		expect(read?.content).toBe(text);
	});
});

describe("snapshot content fields", () => {
	test.each(["plain_text", "rich_text"] as const)(
		"records each saved %s mode without changing older versions",
		async (rootKind) => {
			vi.useFakeTimers();
			const { t, db, asUser, scope, nodeId } = await create_file_fixture(rootKind);
			const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: 0,
			});
			expect(materialized._nay).toBeUndefined();
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId,
				nodeId,
				text: "Saved with collaboration off\n",
			});
			expect(saved._nay).toBeUndefined();

			const tasks = await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect());
			for (const task of tasks) {
				await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
			}
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();

			const snapshots = await t.run((ctx) => ctx.db.query("files_snapshots").collect());
			expect(snapshots.map((snapshot) => snapshot.collaborationEnabled)).toEqual([true, true, false, true]);
			for (const snapshot of snapshots) {
				expect(snapshot).toMatchObject({
					contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: rootKind,
				});
				expect(snapshot).not.toHaveProperty("nonCollaborative");
			}
		},
	);
});

describe("cleanup_file_yjs_task", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	test("bounded cleanup retires before new history and a late task cannot delete the next OFF history", async () => {
		const { t, db, asUser, nodeId, pointers } = await create_file_fixture();
		await t.run(async (ctx) => {
			await ctx.db.patch("files_yjs_snapshots", pointers.yjsSnapshotId, { sequence: 64 });
			await ctx.db.patch("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId, { lastSequence: 64 });
			await Promise.all(
				Array.from({ length: 64 }, (_, index) =>
					ctx.db.insert("files_yjs_updates", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: nodeId,
						sequence: index + 1,
						update: new Uint8Array([0, 0]).buffer,
						origin: { type: "USER_EDIT", sessionId: "old-history" },
						createdBy: db.userId,
						createdAt: Date.now(),
					}),
				),
			);
		});
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const task = await t.run(async (ctx) => ctx.db.query("files_yjs_cleanup_tasks").first());
		if (!task) throw new Error("Missing cleanup task");
		expect(
			await asUser.query(api.files_nodes_content.get_file_collaboration_cleanup_state, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toBe(true);

		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_yjs_updates").collect())).toHaveLength(32);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				})
			)._nay?.message,
		).toContain("old collaboration history");
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_yjs_updates").collect())).toHaveLength(0);
		expect(
			await asUser.query(api.files_nodes_content.get_file_collaboration_cleanup_state, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toBe(false);

		// The final full batch leaves the task pending. ON retires it without waiting for R2.
		expect((await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))?.historyPending).toBe(true);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				})
			)._nay,
		).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))?.historyPending).toBe(false);
		const fresh = await test_get_file_yjs_pointers(t, nodeId);
		const editor = new YjsDoc();
		editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "New edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: fresh.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor)),
					sessionId: "new-history",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		await t.mutation(internal.files_nodes_content.mark_file_content_too_large, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			expectedYjsLastSequenceId: fresh.yjsLastSequenceId,
			sequence: 1,
			targetSequence: 1,
			byteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();

		// Both documents are now off. Only the retired task flag protects the newer update.
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		await t.run(async (ctx) => {
			expect((await ctx.db.query("files_yjs_updates").collect()).map((update) => update.sequence)).toEqual([1]);
			expect(await ctx.db.get("files_yjs_cleanup_tasks", task._id)).toBeNull();
			const deletion = await ctx.db.query("files_r2_object_deletion_jobs").first();
			expect(deletion?.putMayArriveUntil).toBe(task.putMayArriveUntil);
		});
	});

	test("the final ON mutation refuses remaining old history", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run(async (ctx) => {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				update: new Uint8Array([0, 0]).buffer,
				origin: { type: "USER_EDIT", sessionId: "old-history" },
				createdBy: db.userId,
				createdAt: Date.now(),
			});
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.assetId) throw new Error("Missing content asset");
			return { ...node, assetId: node.assetId };
		});
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = await Promise.all(
			(["yjs_snapshot", "content_snapshot"] as const).map((kind) =>
				t.mutation(internal.r2.insert_asset, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					kind,
					size: 14,
				}),
			),
		);
		const finalized = await asUser.mutation(internal.files_nodes_content.finalize_file_collaboration_enable, {
			membershipId: db.membershipId,
			nodeId,
			text: "Original text\n",
			textSize: 14,
			baseAssetId: before.assetId,
			yjsSnapshotAssetId,
			yjsSnapshotSize: 14,
			contentSnapshotAssetId,
		});
		expect(finalized._nay?.message).toContain("old collaboration history");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("restore checks old history before creating a fresh text document", async () => {
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const storedVersionId = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_snapshots", snapshotId);
			if (!snapshot) throw new Error("Missing snapshot");
			return await ctx.db.insert("files_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				assetId: snapshot.assetId,
				createdBy: db.userId,
				archivedAt: 0,
				contentType: "application/octet-stream",
				yjsRootKind: null,
				collaborationEnabled: false,
			});
		});
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey);
			if (body === undefined) throw new Error("Missing source object");
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
		});
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId: storedVersionId,
					sessionId: "restore-stored",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run(async (ctx) => {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				update: new Uint8Array([0, 0]).buffer,
				origin: { type: "USER_EDIT", sessionId: "old-history" },
				createdBy: db.userId,
				createdAt: Date.now(),
			});
			return await ctx.db.get("files_nodes", nodeId);
		});
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "restore-text",
		});
		expect(restored._nay?.message).toContain("old collaboration history");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("two ON finalizations publish only one document", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const results = await Promise.all(
			[0, 1].map(() =>
				asUser.action(api.files_nodes_content.set_file_collaborative, { membershipId: db.membershipId, nodeId }),
			),
		);
		expect(results.filter((result) => result._nay === undefined)).toHaveLength(1);
		expect(results.find((result) => result._nay)?._nay?.message).toContain("already collaborative");
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_yjs_snapshots").collect()).toHaveLength(1);
			expect(await ctx.db.query("files_yjs_docs_last_sequences").collect()).toHaveLength(1);
		});
	});

	test("asset-only cleanup preserves an asset referenced by a live snapshot", async () => {
		const { t, db, nodeId, pointers } = await create_file_fixture();
		const task = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			if (!snapshot) throw new Error("Missing snapshot");
			const taskId = await ctx.db.insert("files_yjs_cleanup_tasks", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				throughSequence: 0,
				supersededYjsAssetId: snapshot.assetId,
				putMayArriveUntil: null,
				historyPending: false,
			});
			return { taskId, assetId: snapshot.assetId };
		});
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task.taskId });
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_yjs_cleanup_tasks", task.taskId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", task.assetId)).not.toBeNull();
			expect(await ctx.db.query("files_r2_object_deletion_jobs").collect()).toHaveLength(0);
		});
	});
});

describe("materialize_file_content and restore_snapshot_r2", () => {
	test.each([false, true])(
		"overlapping downloads and restore keep the latest edit (restore changes text: %s)",
		async (changesText) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const originalText = "Original text\n";
			const editedText = "Original text\nEdit during restore\nSecond edit\n";
			const created = await asUser.action(internal.files_nodes_content.create_file_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/review-restore.txt",
				textContent: originalText,
			});
			if (created._nay) throw new Error(created._nay.message);
			const nodeId = created._yay.nodeId;
			const pointers = await test_get_file_yjs_pointers(t, nodeId);
			const before = await t.run(async (ctx) => {
				const snapshot = await ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.first();
				const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
				if (!snapshot || !yjsSnapshot) throw new Error("Missing created snapshots");
				const asset = await ctx.db.get("files_r2_assets", yjsSnapshot.assetId);
				if (!asset?.r2Key) throw new Error("Missing created Yjs object");
				return { snapshotId: snapshot._id, yjsKey: asset.r2Key };
			});

			// Use the live document's structs, as an open editor does.
			const editor = new YjsDoc();
			const originalYjs = objects.get(before.yjsKey);
			if (!originalYjs) throw new Error("Missing Yjs bytes");
			applyUpdate(editor, new Uint8Array(await new Response(originalYjs).arrayBuffer()));
			if (changesText) {
				const beforeEdit = encodeStateVector(editor);
				editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "Remove this line\n");
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "before-restore",
				});
				if (pushed._nay) throw new Error(pushed._nay.message);
				const materialized = await asUser.action(api.r2.create_signed_download_url, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				});
				if (materialized._nay) throw new Error(materialized._nay.message);
				await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_yjs_push_update", key: db.userId });
			}
			const expectedText = (changesText ? "Remove this line\n" : "") + editedText;
			const stateVector = encodeStateVector(editor);
			const text = editor.getText(files_YJS_DOC_KEYS.plainText);
			text.insert(text.length, "Edit during restore\n");
			const edit = files_u8_to_array_buffer(encodeStateAsUpdate(editor, stateVector));

			// Pause the restore's two PUTs after its read and diff are finished.
			const uploadsStarted = Promise.withResolvers<void>();
			const releaseUploads = Promise.withResolvers<void>();
			const oldYjsPutStarted = Promise.withResolvers<void>();
			const releaseOldYjsPut = Promise.withResolvers<void>();
			const fetchMock = vi.mocked(globalThis.fetch);
			const baseFetch = fetchMock.getMockImplementation();
			if (!baseFetch) throw new Error("Missing R2 stub");
			let pausedUploads = 0;
			let pausedYjsPut = false;
			fetchMock.mockImplementation(async (input, init) => {
				if (init?.method === "PUT" && typeof init.body === "string" && pausedUploads < 2) {
					pausedUploads += 1;
					if (pausedUploads === 2) uploadsStarted.resolve();
					await releaseUploads.promise;
				}
				if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !pausedYjsPut) {
					pausedYjsPut = true;
					oldYjsPutStarted.resolve();
					await releaseOldYjsPut.promise;
				}
				return await baseFetch(input, init);
			});
			const restoring = asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: before.snapshotId,
				sessionId: "review-restore",
			});
			await uploadsStarted.promise;
			try {
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: edit,
					sessionId: "review-other-editor",
				});
				if (pushed._nay) throw new Error(pushed._nay.message);
				// Downloads call the materializer outside its single-worker pool.
				const firstDownload = asUser.action(api.r2.create_signed_download_url, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				});
				await oldYjsPutStarted.promise;
				try {
					const nextVector = encodeStateVector(editor);
					text.insert(text.length, "Second edit\n");
					const secondPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: db.membershipId,
						nodeId,
						expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
						update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, nextVector)),
						sessionId: "review-other-editor",
					});
					if (secondPush._nay) throw new Error(secondPush._nay.message);
					const secondDownload = await asUser.action(api.r2.create_signed_download_url, {
						membershipId: db.membershipId,
						fileNodeId: nodeId,
					});
					if (secondDownload._nay) throw new Error(secondDownload._nay.message);
					const savedKey = await t.run(async (ctx) => {
						const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
						return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
					});
					const savedYjs = objects.get(savedKey);
					if (!savedYjs) throw new Error("Missing saved Yjs bytes");
					const savedDoc = new YjsDoc();
					applyUpdate(savedDoc, new Uint8Array(await new Response(savedYjs).arrayBuffer()));
					expect(savedDoc.getText(files_YJS_DOC_KEYS.plainText).toString()).toBe(expectedText);
					savedDoc.destroy();
				} finally {
					releaseOldYjsPut.resolve();
				}
				const firstDownloadResult = await firstDownload;
				if (firstDownloadResult._nay) throw new Error(firstDownloadResult._nay.message);
				const liveKey = await t.run(async (ctx) => {
					const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
					return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
				});
				const liveBytes = objects.get(liveKey);
				if (!liveBytes) throw new Error("Missing live Yjs bytes");
				const liveDoc = new YjsDoc();
				applyUpdate(liveDoc, new Uint8Array(await new Response(liveBytes).arrayBuffer()));
				// The older worker must not replace the newer worker's saved object.
				expect.soft(liveDoc.getText(files_YJS_DOC_KEYS.plainText).toString()).toBe(expectedText);
				liveDoc.destroy();
			} finally {
				editor.destroy();
				releaseOldYjsPut.resolve();
				releaseUploads.resolve();
			}
			const result = await restoring;
			fetchMock.mockImplementation(baseFetch);
			expect(pausedUploads).toBe(2);
			const after = await t.run(async (ctx) => {
				const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
				const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
				const stages = await ctx.db.query("files_yjs_trusted_update_stages").collect();
				return { snapshotSequence: snapshot?.sequence, lastSequence: sequence?.lastSequence, stages };
			});
			const lastSequence = changesText ? 3 : 2;
			expect(after).toMatchObject({ snapshotSequence: lastSequence, lastSequence });
			expect(after.stages).toHaveLength(changesText ? 1 : 0);
			// A refused, unconsumed restore update is removed by the trusted-stage expiry job.
			for (const stage of after.stages) expect(stage.expiresAt).toBeGreaterThan(Date.now());
			await expect_retired_uploads(t, 4);
			const read = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/review-restore.txt",
			});
			expect.soft(result._nay?.message).toBe("This file changed while the snapshot was being restored. Try again.");
			expect.soft(read?.content).toBe(expectedText);
		},
	);
});

describe("materialize_file_content", () => {
	test("two workers for the same counter publish once and retire the unused uploads", async () => {
		const { t, scope, nodeId, pointers } = await create_file_fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let paused = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !paused) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return baseFetch(input, init);
		});
		const first = t.action(internal.files_nodes_content.materialize_file_content, {
			...scope,
			nodeId,
			targetSequence: 0,
		});
		await started.promise;
		try {
			const second = await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: 0,
			});
			expect(second._nay).toBeUndefined();
		} finally {
			release.resolve();
		}
		expect((await first)._nay).toBeUndefined();
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_snapshots").collect()).toHaveLength(2);
		});
		await expect_retired_uploads(t, 2);
	});

	test("a worker paused before OFF and ON cannot publish into the new document", async () => {
		const { t, db, asUser, scope, nodeId, pointers } = await create_file_fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let paused = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !paused) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return baseFetch(input, init);
		});
		const materializing = t.action(internal.files_nodes_content.materialize_file_content, {
			...scope,
			nodeId,
			targetSequence: 0,
		});
		await started.promise;
		try {
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();
			const newPointers = await test_get_file_yjs_pointers(t, nodeId);
			expect(newPointers.yjsLastSequenceId).not.toBe(pointers.yjsLastSequenceId);
			const before = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db.get("files_yjs_snapshots", newPointers.yjsSnapshotId),
			}));
			release.resolve();
			expect((await materializing)._nay).toBeUndefined();
			await t.run(async (ctx) => {
				expect(await ctx.db.get("files_nodes", nodeId)).toEqual(before.node);
				expect(await ctx.db.get("files_yjs_snapshots", newPointers.yjsSnapshotId)).toEqual(before.snapshot);
			});
			await expect_retired_uploads(t, 2);
		} finally {
			release.resolve();
		}
	});
});

describe("restore_snapshot_r2", () => {
	test("uses the saved type for download and same-shape restore after the current type changes", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId, pointers } = await create_file_fixture();
		const originalSnapshot = await t.run((ctx) => ctx.db.get("files_snapshots", snapshotId));
		await t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { contentType: "application/json" }));

		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		getUrl.mockClear();
		const fetchObject = vi.mocked(fetch);
		fetchObject.mockClear();
		const download = await asUser.action(api.files_nodes.create_file_snapshot_content_url, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
		});
		expect(download?.snapshotId).toBe(snapshotId);
		expect(getUrl).toHaveBeenCalledWith(expect.any(String), {
			expiresIn: 15 * 60,
			responseContentType: "text/plain;charset=utf-8",
			responseContentDisposition: "attachment; filename*=UTF-8''restore.txt",
		});
		expect(fetchObject).not.toHaveBeenCalled();

		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "restore-saved-type",
		});
		expect(restored._nay).toBeUndefined();
		const result = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			snapshots: await ctx.db.query("files_snapshots").collect(),
			originalSnapshot: await ctx.db.get("files_snapshots", snapshotId),
		}));
		expect(result.node).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
			yjsSnapshotId: pointers.yjsSnapshotId,
			yjsLastSequenceId: pointers.yjsLastSequenceId,
		});
		expect(result.snapshots.slice(-2).map((snapshot) => snapshot.contentType)).toEqual([
			"application/json",
			"text/plain;charset=utf-8",
		]);
		expect(result.originalSnapshot).toEqual(originalSnapshot);
	});

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			[true, false].map((collaborationEnabled) => ({ rootKind, collaborationEnabled })),
		),
	)(
		"restores a stored destination to $rootKind with saved collaboration $collaborationEnabled",
		async ({ rootKind, collaborationEnabled }) => {
			vi.useFakeTimers();
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture(rootKind);
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			let textSnapshotId = snapshotId;
			if (!collaborationEnabled) {
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Saved with collaboration off\n",
				});
				expect(saved._nay).toBeUndefined();
				textSnapshotId = await t.run(async (ctx) => (await ctx.db.query("files_snapshots").order("desc").first())!._id);
			}

			const storedSnapshotId = await t.run(async (ctx) => {
				const snapshot = await ctx.db.get("files_snapshots", snapshotId);
				if (!snapshot) throw new Error("Missing original snapshot");
				return await ctx.db.insert("files_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					assetId: snapshot.assetId,
					createdBy: db.userId,
					archivedAt: 0,
					contentType: "application/octet-stream",
					yjsRootKind: null,
					collaborationEnabled: false,
				});
			});
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = objects.get(args.sourceKey)!;
				objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "stored" };
			});
			const stored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: storedSnapshotId,
				sessionId: "restore-stored-first",
			});
			expect(stored._nay).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
				textKind: null,
				collaborationEnabled: null,
			});

			const restoreData = await t.query(internal.files_nodes_content.get_data_for_restore_snapshot, {
				userId: db.userId,
				membershipId: db.membershipId,
				nodeId,
				snapshotId: textSnapshotId,
			});
			expect(restoreData?.snapshotContent).toMatchObject({
				yjsRootKind: rootKind,
				collaborationEnabled,
			});
			expect(restoreData?.snapshotContent).not.toHaveProperty("nonCollaborative");
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: textSnapshotId,
				sessionId: "restore-saved-mode",
			});
			expect(restored._nay).toBeUndefined();
			const result = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db.query("files_snapshots").order("desc").first(),
			}));
			expect(result.node?.collaborationEnabled).toBe(collaborationEnabled);
			expect(result.node?.textKind).toBe(rootKind);
			expect(result.node?.yjsSnapshotId !== null).toBe(collaborationEnabled);
			expect(result.snapshot).toMatchObject({
				contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
				yjsRootKind: rootKind,
				collaborationEnabled,
			});
		},
	);

	test.each(["text/plain;charset=utf-8", "text/html"])(
		"copies null-shaped %s bytes without parsing",
		async (contentType) => {
			vi.useFakeTimers();
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
			await t.run((ctx) =>
				ctx.db.patch("files_snapshots", snapshotId, {
					contentType,
					yjsRootKind: null,
					collaborationEnabled: false,
				}),
			);
			const scope = { userId: db.userId, membershipId: db.membershipId, nodeId, snapshotId };
			const restoreData = await t.query(internal.files_nodes_content.get_data_for_restore_snapshot, scope);
			const downloadData = await t.query(internal.files_nodes.get_data_for_create_file_snapshot_content_url, scope);
			expect(restoreData?.snapshotContent?.yjsRootKind).toBeNull();
			expect(restoreData?.snapshotContent).not.toHaveProperty("nonCollaborative");
			expect(restoreData?.snapshotContent?.collaborationEnabled).toBe(false);
			expect(downloadData?.yjsRootKind).toBeNull();
			expect(downloadData).not.toHaveProperty("nonCollaborative");
			expect(downloadData?.contentType).toBe(contentType);
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();

			const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x00, 0xff]);
			if (!restoreData?.snapshotContent?.asset.r2Key) throw new Error("Missing snapshot key");
			objects.set(restoreData.snapshotContent.asset.r2Key, bytes);
			const copy = vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				objects.set(args.destinationKey, objects.get(args.sourceKey)!);
				return { outcome: "copied", size: bytes.byteLength, etag: "stored-text" };
			});
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId,
				sessionId: "null-stored-shape",
			});
			expect(restored._nay).toBeUndefined();
			const result = await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", nodeId);
				const assetId = node?.assetId;
				if (!assetId) throw new Error("Missing restored asset");
				return {
					node,
					asset: await ctx.db.get("files_r2_assets", assetId),
					snapshot: await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", assetId))
						.first(),
				};
			});
			expect(new Uint8Array(await new Response(objects.get(result.asset!.r2Key!)).arrayBuffer())).toEqual(bytes);
			expect(copy).toHaveBeenCalledOnce();
			expect(result.node).toMatchObject({ textKind: null, collaborationEnabled: null, yjsSnapshotId: null });
			expect(result.snapshot).toMatchObject({
				contentType,
				yjsRootKind: null,
				collaborationEnabled: false,
			});
			expect(result.snapshot).not.toHaveProperty("nonCollaborative");
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((sourceRootKind) =>
			(["plain_text", "rich_text"] as const).flatMap((targetRootKind) =>
				[false, true].map((off) => ({ sourceRootKind, targetRootKind, off })),
			),
		),
	)(
		"preserves every owner's proposal and expiry across repeated restores: %j",
		async ({ sourceRootKind, targetRootKind, off }) => {
			const fixture = await create_file_fixture(sourceRootKind);
			const { t, db, asUser, nodeId, snapshotId } = fixture;
			await create_pending_proposal(fixture);
			const otherUserId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "restore_other_owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return userId;
			});
			await create_pending_proposal(fixture, otherUserId);
			if (off) {
				const toggled = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				});
				expect(toggled._nay).toBeUndefined();
			}

			const readProposals = () =>
				t.run(async (ctx) => {
					const [pending, states, pages, cleanup, chunks, searchChunks, metadata] = await Promise.all([
						ctx.db.query("files_pending_updates").collect(),
						ctx.db.query("files_pending_update_yjs_states").collect(),
						ctx.db.query("files_pending_update_yjs_state_pages").collect(),
						ctx.db.query("files_pending_updates_cleanup_tasks").collect(),
						ctx.db
							.query("files_text_chunks")
							.filter((q) => q.neq(q.field("pendingUpdateId"), undefined))
							.collect(),
						ctx.db
							.query("files_plain_text_chunks")
							.filter((q) => q.neq(q.field("pendingUpdateId"), undefined))
							.collect(),
						ctx.db
							.query("files_metadata_docs")
							.filter((q) => q.eq(q.field("sourceKind"), "pending"))
							.collect(),
					]);
					return { pending, states, pages, cleanup, chunks, searchChunks, metadata };
				});
			const before = await readProposals();
			expect(before.pending).toHaveLength(2);
			const restoredText = "Restored text\n";
			const versionId = await t.run(async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					size: new TextEncoder().encode(restoredText).byteLength,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const r2Key = `test/restore-version-${assetId}`;
				objects.set(r2Key, restoredText);
				await ctx.db.patch("files_r2_assets", assetId, { r2Key });
				return await ctx.db.insert("files_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					assetId,
					createdBy: db.userId,
					archivedAt: 0,
					contentType: targetRootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: targetRootKind,
					collaborationEnabled: true,
				});
			});
			for (const [restoreId, rootKind, text] of [
				[versionId, targetRootKind, restoredText],
				[snapshotId, sourceRootKind, "Original text\n"],
			] as const) {
				const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId: restoreId,
					sessionId: "restore-preserved-proposals",
				});
				expect(restored._nay).toBeUndefined();
				expect(await readProposals()).toEqual({
					...before,
					pending: before.pending.map((pending) => ({
						...pending,
						contentNeedsRebase: true,
						contentRebaseRootKind: sourceRootKind,
					})),
				});
				const node = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
				expect(node?.textKind).toBe(rootKind);
				expect(node?.collaborationEnabled === false).toBe(off);
				const content = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...fixture.scope,
					path: sourceRootKind === "rich_text" ? "/restore.md" : "/restore.txt",
				});
				expect(content?.content).toBe(text);
			}
		},
	);

	test("normalizes a version saved with collaboration off when the live document already matches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/normalize.md",
			textContent: "# Original\n",
		});
		if (created._nay) throw new Error(created._nay.message);
		const nodeId = created._yay.nodeId;
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: "# Title",
		});
		expect(saved._nay).toBeUndefined();
		const version = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
			const snapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", node!.assetId!))
				.first();
			return { snapshotId: snapshot!._id, r2Key: asset!.r2Key! };
		});
		expect(objects.get(version.r2Key)).toBe("# Title");

		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-normalized",
		});
		expect(restored._nay).toBeUndefined();
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
			const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			const yjsAsset = await ctx.db.get("files_r2_assets", yjsSnapshot!.assetId);
			return { contentKey: asset!.r2Key!, yjsKey: yjsAsset!.r2Key! };
		});
		expect.soft(await new Response(objects.get(after.contentKey)).text()).toBe("# Title\n");
		const yjsDoc = new YjsDoc();
		applyUpdate(yjsDoc, new Uint8Array(await new Response(objects.get(after.yjsKey)).arrayBuffer()));
		const yjsText = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		expect(yjsText._yay).toBe("# Title\n");
		yjsDoc.destroy();

		const download = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
		});
		if (download._nay) throw new Error(download._nay.message);
		expect(await (await fetch(download._yay.url)).text()).toBe("# Title\n");
	});

	test("requires the Properties confirmation before a stored version removes shared history", async () => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, snapshotId, pointers } = fixture;
		const pending = await create_pending_proposal(fixture);
		// A historical version saved as stored bytes, before the file became editable text.
		await t.run(async (ctx) =>
			ctx.db.patch("files_snapshots", snapshotId, {
				contentType: "application/octet-stream",
				yjsRootKind: null,
				collaborationEnabled: false,
			}),
		);
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey)!;
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: new TextEncoder().encode(String(body)).byteLength, etag: "copied" };
		});
		const restore = () =>
			asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId,
				sessionId: "restore-stored",
			});
		const refused = await restore();
		expect(refused._nay?.message).toBe(
			"Turn collaboration off in Properties before replacing this text file with stored content.",
		);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.filter((job) => job.reason === "failed_create")).toHaveLength(1);
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		expect((await restore())._nay).toBeUndefined();
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentType).toBe("application/octet-stream");
		expect(node?.yjsSnapshotId).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual({
			...pending,
			contentNeedsRebase: true,
			contentRebaseRootKind: "plain_text",
		});
	});

	test.each([false, true])(
		"keeps the destination mode when the version has the opposite mode (off: %s)",
		async (destinationOff) => {
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			let versionId = snapshotId;
			if (!destinationOff) {
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Version saved with collaboration off\n",
				});
				expect(saved._nay).toBeUndefined();
				versionId = await t.run(async (ctx) => {
					const node = await ctx.db.get("files_nodes", nodeId);
					return (await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", node!.assetId!))
						.first())!._id;
				});
			}
			const savedCurrent = await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId,
				nodeId,
				text: "Current text to replace\n",
			});
			expect(savedCurrent._nay).toBeUndefined();
			if (!destinationOff) {
				const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				});
				expect(on._nay).toBeUndefined();
			}
			const before = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: versionId,
				sessionId: "restore-mode",
			});
			expect(restored._nay).toBeUndefined();
			const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			expect(after?.collaborationEnabled === false).toBe(destinationOff);
			const assetId = after?.assetId;
			if (!assetId) throw new Error("Missing restored content asset");
			const restoredSnapshot = await t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.withIndex("by_asset", (q) => q.eq("assetId", assetId))
					.first(),
			);
			expect(restoredSnapshot).toMatchObject({
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: !destinationOff,
			});
			expect(after?.yjsLastSequenceId).toBe(before?.yjsLastSequenceId);
			expect(after?.yjsSnapshotId).toBe(before?.yjsSnapshotId);
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/restore.txt",
			});
			expect(read?.content).toBe(destinationOff ? "Original text\n" : "Version saved with collaboration off\n");
		},
	);
});

describe("accept_file_pending_replacement", () => {
	test.each(["text", "stored bytes"] as const)(
		"drops another owner's retained proposal when copying %s after a stored-byte restore",
		async (sourceKind) => {
			const fixture = await create_file_fixture("rich_text");
			const { t, db, asUser, scope, nodeId, snapshotId } = fixture;
			const otherUserId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "copy_after_restore_owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return userId;
			});
			const pending = await create_pending_proposal(fixture, otherUserId);
			await t.run((ctx) =>
				ctx.db.patch("files_snapshots", snapshotId, {
					contentType: "application/octet-stream",
					yjsRootKind: null,
					collaborationEnabled: false,
				}),
			);
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = objects.get(args.sourceKey)!;
				objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
			});
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: db.membershipId,
						nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
						membershipId: db.membershipId,
						nodeId,
						snapshotId,
						sessionId: "copy-after-stored-restore",
					})
				)._nay,
			).toBeUndefined();
			expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.textKind).toBeNull();
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual({
				...pending,
				contentNeedsRebase: true,
				contentRebaseRootKind: "rich_text",
			});
			const source =
				sourceKind === "text"
					? await t.action(internal.files_nodes_content.create_file_by_path, {
							...scope,
							path: "/source.txt",
							textContent: "Copied text\n",
						})
					: await asUser.mutation(api.files_nodes.create_upload_node, {
							membershipId: db.membershipId,
							parentId: files_ROOT_ID,
							filename: "source.pdf",
							contentType: "application/pdf",
							size: 3,
						});
			if (source._nay) throw new Error(source._nay.message);
			const sourceNode = await t.run((ctx) => ctx.db.get("files_nodes", source._yay.nodeId));
			if (!sourceNode?.assetId) throw new Error("Missing copy source");
			if (sourceKind === "stored bytes") {
				const r2Key = "test/copy-after-restore.pdf";
				objects.set(r2Key, new Uint8Array([0, 255, 128]));
				await t.run((ctx) => ctx.db.patch("files_r2_assets", sourceNode.assetId!, { r2Key }));
			}
			const staged = await t.action(internal.files_pending_updates.stage_file_pending_replacement_internal_action, {
				...scope,
				nodeId,
				source: { nodeId: sourceNode._id, path: sourceNode.path },
				expectedSourceAssetId: sourceNode.assetId,
				...(sourceKind === "text" ? { sourceText: "Copied text\n" } : {}),
			});
			if (staged._nay) throw new Error(staged._nay.message);
			expect(
				(
					await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
						membershipId: db.membershipId,
						nodeId,
						pendingUpdateId: staged._yay.pendingUpdateId,
					})
				)._nay,
			).toBeUndefined();
			await t.run(async (ctx) => {
				expect(await ctx.db.get("files_pending_updates", pending._id)).toBeNull();
				expect(
					await ctx.db
						.query("files_text_chunks")
						.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pending._id))
						.collect(),
				).toHaveLength(0);
			});
		},
	);

	test("accepts stored bytes for a new eager copy and saves edits to its placeholder", async () => {
		const { t, db, asUser, scope, nodeId, pointers } = await create_file_fixture();
		const sourceBytes = new Uint8Array([0, 255, 10, 13, 128]);
		const source = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "source.pdf",
			contentType: "application/pdf",
			size: sourceBytes.byteLength,
		});
		if (source._nay) throw new Error(source._nay.message);
		const sourceKey = "test/stored-source.pdf";
		objects.set(sourceKey, sourceBytes);
		await t.run(async (ctx) => ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: sourceKey }));
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey)!;
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: sourceBytes.byteLength, etag: "copied" };
		});
		const staged = await t.action(internal.files_pending_updates.stage_file_pending_replacement_internal_action, {
			...scope,
			nodeId,
			source: { nodeId: source._yay.nodeId, path: "/source.pdf" },
			expectedSourceAssetId: source._yay.assetId,
			eagerCreatedCommittedSequence: 0,
		});
		if (staged._nay) throw new Error(staged._nay.message);
		const pending = await t.run(async (ctx) => ctx.db.get("files_pending_updates", staged._yay.pendingUpdateId));
		expect(pending?.eagerCreated).toEqual({ committedSequence: 0 });

		// The open editor can still change the placeholder before the copy is accepted.
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		text.insert(text.length, "Edit before accepting the copy\n");
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
			sessionId: "eager-copy-editor",
		});
		editor.destroy();
		expect(pushed._nay).toBeUndefined();

		const accepted = await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: db.membershipId,
			nodeId,
			pendingUpdateId: staged._yay.pendingUpdateId,
		});
		expect(accepted._nay).toBeUndefined();
		const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(after?.contentType).toBe("application/pdf");
		expect(after?.assetId).toBe(pending?.pendingReplacement?.assetId);
		expect(after?.textKind).toBeNull();
		expect(after?.statsId).toBeNull();
		expect(after?.yjsSnapshotId).toBeNull();
		expect(after?.yjsLastSequenceId).toBeNull();
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", after!.assetId!));
		expect(new Uint8Array(await new Response(objects.get(asset!.r2Key!)).arrayBuffer())).toEqual(sourceBytes);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_updates", staged._yay.pendingUpdateId))).toBeNull();

		const backupKey = await t.run(async (ctx) => {
			const backup = await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.filter((q) => q.eq(q.field("yjsRootKind"), "plain_text"))
				.order("desc")
				.first();
			expect(backup).toMatchObject({
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: true,
			});
			return (await ctx.db.get("files_r2_assets", backup!.assetId))!.r2Key!;
		});
		expect(await new Response(objects.get(backupKey)).text()).toBe("Original text\nEdit before accepting the copy\n");
	});

	test.each([
		{ sourceOff: true, destinationOff: false, eager: false },
		{ sourceOff: false, destinationOff: true, eager: false },
		{ sourceOff: true, destinationOff: false, eager: true },
		{ sourceOff: false, destinationOff: false, eager: true },
	])(
		"uses the destination mode for existing files and source mode for new copies: %j",
		async ({ sourceOff, destinationOff, eager }) => {
			const { t, db, asUser, scope, nodeId } = await create_file_fixture();
			const created = await t.action(internal.files_nodes_content.create_file_by_path, {
				...scope,
				path: "/source.txt",
				textContent: "Copied text\n",
			});
			if (created._nay) throw new Error(created._nay.message);
			const sourceId = created._yay.nodeId;
			for (const id of [sourceOff ? sourceId : null, destinationOff ? nodeId : null]) {
				if (id === null) continue;
				const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId: id,
					acknowledgeDropCollaborativeHistory: true,
				});
				expect(off._nay).toBeUndefined();
			}
			const source = await t.run(async (ctx) => ctx.db.get("files_nodes", sourceId));
			const staged = await t.action(internal.files_pending_updates.stage_file_pending_replacement_internal_action, {
				...scope,
				nodeId,
				source: { nodeId: sourceId, path: "/source.txt" },
				expectedSourceAssetId: source!.assetId!,
				sourceText: "Copied text\n",
				...(eager ? { eagerCreatedCommittedSequence: 0 } : {}),
			});
			if (staged._nay) throw new Error(staged._nay.message);
			const accepted = await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
				membershipId: db.membershipId,
				nodeId,
				pendingUpdateId: staged._yay.pendingUpdateId,
			});
			expect(accepted._nay).toBeUndefined();
			const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			const expectedOff = eager ? sourceOff : destinationOff;
			expect(after?.collaborationEnabled === false).toBe(expectedOff);
			const assetId = after?.assetId;
			if (!assetId) throw new Error("Missing copied content asset");
			const copiedSnapshot = await t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.withIndex("by_asset", (q) => q.eq("assetId", assetId))
					.first(),
			);
			expect(copiedSnapshot).toMatchObject({
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: !expectedOff,
			});
			expect(after?.yjsLastSequenceId !== null).toBe(!expectedOff);
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				...scope,
				path: "/restore.txt",
			});
			expect(read?.content).toBe("Copied text\n");
		},
	);
});
