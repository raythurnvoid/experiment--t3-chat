import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_nodes_db_create_private_node_by_path, files_nodes_db_get_content_version } from "./files_nodes.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { r2_create_asset_key } from "./r2_client.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_read" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key) => `https://r2.test/${key}`);
});

afterEach(() => vi.restoreAllMocks());

async function create_fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const threadId = await t.run((ctx) =>
		ctx.db.insert("ai_chat_threads", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			clientGeneratedId: "file-read",
			title: null,
			archived: false,
			runtime: "aisdk_5",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
		}),
	);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const file = await t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			kind: "content",
			r2Bucket: "test",
			size: 4,
			updatedAt: Date.now(),
		});
		const r2Key = r2_create_asset_key({ ...scope, assetId });
		await ctx.db.patch("files_r2_assets", assetId, { r2Key });
		const reserved = await files_private_storage_db_reserve(ctx, {
			...scope,
			resource: { kind: "asset", id: assetId, r2Key },
			byteCount: 4,
		});
		if (reserved._nay) throw new Error(reserved._nay.message);
		const created = await files_nodes_db_create_private_node_by_path(ctx, {
			...scope,
			path: "/output",
			kind: "file",
			content: { kind: "stored", assetId, size: 4, contentType: "application/octet-stream" },
		});
		if (created._nay || created._yay.target.kind !== "private") throw new Error("Expected private file");
		return { ...created._yay, target: created._yay.target, assetId };
	});
	const readArgs = {
		userId: db.userId,
		membershipId: db.membershipId,
		agentSource: {
			...scope,
			membershipId: db.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			threadId,
		},
		path: "/output",
	};
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const save = async () => {
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: db.membershipId,
			target: file.target,
		});
		if (!view?.entry.pendingUpdate) throw new Error("Expected a proposal");
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: db.membershipId,
			target: file.target,
			pendingUpdateId: view.entry.pendingUpdate._id,
			reviewedRevision: view.entry.pendingUpdate.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved file");
		return saved._yay.target;
	};
	return { t, db, scope, file, readArgs, save };
}

describe("get_file_read_source", () => {
	test("reads by path and keeps one saved revision through old private links", async () => {
		const { t, file, readArgs, save } = await create_fixture();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay).toMatchObject({
			target: file.target,
			assetId: file.assetId,
		});
		const saved = await save();
		const reads = await Promise.all(
			[file.target, { kind: "saved" as const, id: saved.id }, { id: saved.id, kind: "saved" as const }].map((target) =>
				t.query(internal.files_nodes_content.get_file_read_source, { ...readArgs, target }),
			),
		);
		for (const read of reads) expect(read._yay).toMatchObject({ target: saved, assetId: file.assetId });
		expect(new Set(reads.map((read) => read._yay?.revision)).size).toBe(1);
	});

	test("reads a held replacement and pins its proposal and path", async () => {
		const { t, scope, file, readArgs, save } = await create_fixture();
		const target = await save();
		const saved = await t.query(internal.files_nodes_content.get_file_read_source, readArgs);
		const { pendingUpdateId, replacementAssetId } = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", target.id);
			if (!node) throw new Error("Expected saved file");
			const baseContentVersion = await files_nodes_db_get_content_version(ctx, node);
			if (!baseContentVersion) throw new Error("Expected stored version");
			const replacementAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				kind: "content",
				r2Bucket: "test",
				size: 2,
				updatedAt: Date.now(),
			});
			const r2Key = r2_create_asset_key({ ...scope, assetId: replacementAssetId });
			await ctx.db.patch("files_r2_assets", replacementAssetId, { r2Key });
			await files_private_storage_db_reserve(ctx, {
				...scope,
				resource: { kind: "asset", id: replacementAssetId, r2Key },
				byteCount: 2,
			});
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				...scope,
				target,
				revision: 1,
				size: 2,
				updatedAt: Date.now(),
				expiresAt: Date.now() + 4 * 60 * 60 * 1000,
				pendingReplacement: {
					assetId: replacementAssetId,
					size: 2,
					contentType: "application/x-new",
					baseAssetId: file.assetId,
					baseContentVersion,
				},
			});
			return { pendingUpdateId, replacementAssetId };
		});
		const replacement = await t.query(internal.files_nodes_content.get_file_read_source, readArgs);
		expect(replacement._yay).toMatchObject({ assetId: replacementAssetId, size: 2, contentType: "application/x-new" });
		expect(replacement._yay?.revision).not.toBe(saved._yay?.revision);
		await t.run((ctx) =>
			ctx.db.patch("files_pending_updates", pendingUpdateId, {
				revision: 2,
				pendingMove: { destParent: { kind: "root" }, destName: "renamed", fromPath: "/output" },
			}),
		);
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._nay).toBeDefined();
		const movedArgs = { ...readArgs, path: "/renamed", target };
		const moved = await t.query(internal.files_nodes_content.get_file_read_source, movedArgs);
		expect(moved._yay?.revision).not.toBe(replacement._yay?.revision);
		await t.run((ctx) =>
			ctx.db.patch("files_pending_updates", pendingUpdateId, {
				revision: 3,
				pendingArchive: { fromPath: "/renamed" },
			}),
		);
		expect((await t.query(internal.files_nodes_content.get_file_read_source, movedArgs))._nay).toBeDefined();
	});

	test("refuses preparing text and bytes without their private storage hold", async () => {
		const { t, scope, file, readArgs } = await create_fixture();
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/draft.txt",
			kind: "file",
		});
		if (created._nay) throw new Error(created._nay.message);
		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					...readArgs,
					path: "/draft.txt",
					target: created._yay.target,
				})
			)._nay,
		).toBeDefined();
		await t.run(async (ctx) => {
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", file.assetId))
				.first();
			await ctx.db.delete("files_private_storage_reservations", hold!._id);
		});
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._nay).toBeDefined();
	});
});

describe("get_path_by_id", () => {
	test("follows a private identity after Save and cleanup using current access", async () => {
		const { t, db, file, save } = await create_fixture();
		const args = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			nodeId: file.target.id,
		};
		expect(await t.query(internal.files_nodes.get_path_by_id, args)).toBe("/output");
		const saved = await save();
		await t.run((ctx) => ctx.db.delete("files_pending_nodes", file.target.id));
		expect(await t.query(internal.files_nodes.get_path_by_id, args)).toBe("/output");
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
		expect(await t.query(internal.files_nodes.get_path_by_id, args)).toBeNull();
		expect(await t.query(internal.files_nodes.get_path_by_id, { ...args, nodeId: saved.id })).toBeNull();
	});
});
