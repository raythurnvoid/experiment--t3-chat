import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
import { files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { test_convex, test_rename_node, test_move_nodes, test_create_saved_text_file, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

beforeEach(() => {
	// Scheduled job steps run only when a test finishes them.
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(args: { displayName?: string } = {}) {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const db = await test_mocks_fill_db_with.membership(ctx);
		if (args.displayName !== undefined) {
			const anagraphic = await ctx.db.insert("users_anagraphics", {
				userId: db.userId,
				displayName: args.displayName,
				email: "updater@example.com",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", db.userId, { anagraphic });
		}
		return db;
	});
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

	const create_folder = async (path: string) => {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};

	const read_doc = (fileNodeId: Id<"files_nodes">) =>
		t.run(async (ctx) => {
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", fileNodeId))
				.first();
			if (!doc) return null;
			const { _id, _creationTime, ...fields } = doc;
			return fields;
		});

	const read_node = (nodeId: Id<"files_nodes">) =>
		t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node) throw new Error("Missing node");
			return node;
		});

	const rename_user = (displayName: string | null) =>
		t.run(async (ctx) => {
			const user = await ctx.db.get("users", db.userId);
			if (!user?.anagraphic) throw new Error("Missing anagraphic");
			if (displayName === null) {
				await ctx.db.patch("users", db.userId, { anagraphic: undefined });
				await ctx.db.delete("users_anagraphics", user.anagraphic);
			} else {
				await ctx.db.patch("users_anagraphics", user.anagraphic, { displayName });
			}
		});

	// Copies of one real doc with other keys. The drain reads only `userId` and `sortUserName`.
	const seed_docs = (args: { templateNodeId: Id<"files_nodes">; userId: Id<"users">; name: string; count: number }) =>
		t.run(async (ctx) => {
			const template = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.templateNodeId))
				.first();
			if (!template) throw new Error("Missing template doc");
			const { _id, _creationTime, ...fields } = template;
			for (let index = 0; index < args.count; index += 1) {
				await ctx.db.insert("files_updated_by_docs", {
					...fields,
					userId: args.userId,
					sortUserName: files_sort_text_key(args.name),
				});
			}
		});

	const read_user_keys = (userId: Id<"users">) =>
		t.run(async (ctx) =>
			(
				await ctx.db
					.query("files_updated_by_docs")
					.withIndex("by_user_sort", (q) => q.eq("userId", userId))
					.collect()
			).map((doc) => doc.sortUserName),
		);

	const drain = (args: { _test_batchSize?: number; _test_disableReschedule?: boolean } = {}) =>
		t.mutation(internal.files_updated_by.drain_user_name, { userId: db.userId, ...args });

	const scheduled_drains = () =>
		t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
				job.name.endsWith("drain_user_name"),
			),
		);

	return {
		t,
		db,
		asOwner,
		create_folder,
		read_doc,
		read_node,
		rename_user,
		seed_docs,
		read_user_keys,
		drain,
		scheduled_drains,
	};
}

describe("files_updated_by_docs sync", () => {
	test("a new folder and a published file copy their node and the updater's name", async () => {
		const { t, db, read_doc, read_node } = await fixture({ displayName: "Zoë Writer" });
		const fileId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path: "/reports/q1.md" });
		const folderId = (await read_node(fileId)).parentId as Id<"files_nodes">;

		const shared = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			isRestrictedScopeRoot: false,
			sortUserName: files_sort_text_key("Zoë Writer"),
		};
		expect(await read_doc(folderId)).toEqual({
			...shared,
			fileNodeId: folderId,
			parentId: files_ROOT_ID,
			nodeKind: "folder",
			name: "reports",
			sortName: files_sort_text_key("reports"),
		});
		expect(await read_doc(fileId)).toEqual({
			...shared,
			fileNodeId: fileId,
			parentId: folderId,
			nodeKind: "file",
			name: "q1.md",
			sortName: files_sort_text_key("q1.md"),
		});
	});

	test("an updater with no name sorts as Unknown", async () => {
		const { create_folder, read_doc } = await fixture();
		const folderId = await create_folder("/nameless");

		expect(await read_doc(folderId)).toMatchObject({ sortUserName: files_sort_text_key("Unknown") });
	});

	test("the member folder door gives every folder it creates a doc", async () => {
		const { t, db, asOwner, read_doc } = await fixture({ displayName: "Door User" });

		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "/outer/inner",
		});
		if (created._nay) throw new Error(created._nay.message);
		const outerId = await t.run(
			async (ctx) => (await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/outer")!._id,
		);

		expect(await read_doc(outerId)).toMatchObject({ parentId: files_ROOT_ID, name: "outer", nodeKind: "folder" });
		expect(await read_doc(created._yay.nodeId)).toMatchObject({ parentId: outerId, name: "inner" });
	});

	test("the member file door gives the new file a doc", async () => {
		const { db, asOwner, read_doc } = await fixture({ displayName: "Door User" });

		const created = await asOwner.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "/notes.md",
		});
		if (created._nay) throw new Error(created._nay.message);

		expect(await read_doc(created._yay.nodeId)).toMatchObject({
			parentId: files_ROOT_ID,
			name: "notes.md",
			nodeKind: "file",
			sortUserName: files_sort_text_key("Door User"),
		});
	});

	test("a rename into new folders and a folder move update the docs", async () => {
		const { t, db, asOwner, create_folder, read_doc } = await fixture();
		await create_folder("/sort-parent");
		const leafId = await create_folder("/sort-parent/leaf");

		// The rename creates two folders. The leaf gets the inner one's id only when the plan is applied.
		const renamed = await test_rename_node(t, asOwner, {
			membershipId: db.membershipId,
			nodeId: leafId,
			path: "new/deep/zeta",
		});
		expect(renamed._nay).toBeUndefined();
		const { newId, deepId } = await t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			return {
				newId: nodes.find((node) => node.path === "/sort-parent/new")!._id,
				deepId: nodes.find((node) => node.path === "/sort-parent/new/deep")!._id,
			};
		});
		expect(await read_doc(deepId)).toMatchObject({ parentId: newId, name: "deep", nodeKind: "folder" });
		expect(await read_doc(leafId), "renamed leaf").toMatchObject({
			parentId: deepId,
			name: "zeta",
			sortName: files_sort_text_key("zeta"),
		});

		const moved = await test_move_nodes(t, asOwner, {
				membershipId: db.membershipId,
				itemIds: [newId],
				targetParentId: files_ROOT_ID,
			});
		expect(moved._nay).toBeUndefined();
		expect(await read_doc(newId), "moved folder").toMatchObject({ parentId: files_ROOT_ID, name: "new" });
		expect(await read_doc(leafId)).toMatchObject({ parentId: deepId, name: "zeta" });
	});

	test("a move over an existing file archives the destination's doc", async () => {
		const { t, db, asOwner, read_doc, read_node } = await fixture();
		const occupantId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path: "/doc.md" });
		const sourceId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path: "/src/doc.md" });

		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [sourceId],
			targetParentId: "root",
			replaceNodeId: occupantId,
		});
		expect(moved._nay).toBeUndefined();

		const occupant = await read_node(occupantId);
		expect(occupant.archiveOperationId).not.toBeNull();
		expect(await read_doc(occupantId), "archived destination").toMatchObject({
			archiveOperationId: occupant.archiveOperationId,
			userId: occupant.updatedBy,
			name: occupant.name,
		});
		expect(await read_doc(sourceId)).toMatchObject({ parentId: files_ROOT_ID, name: "doc.md" });
	});

	test("an archive job archives every doc in a big folder, and a restore makes them active again", async () => {
		const { t, db, asOwner, create_folder, read_doc, read_node } = await fixture();
		const folderId = await create_folder("/big");
		// More children than one job step reads, so the archive needs later steps.
		const childIds = await t.run(async (ctx) => {
			const ids = [];
			for (let index = 0; index < 80; index++) {
				const name = `f${String(index).padStart(3, "0")}`;
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: folderId,
					name,
					sortName: files_sort_text_key(name),
					path: `/big/${name}`,
					treePath: `/big/${name}/`,
					pathDepth: 2,
				});
				await files_updated_by_db_sync_node(ctx, { nodeId });
				ids.push(nodeId);
			}
			return ids;
		});

		const archived = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folderId],
		});
		expect(archived._nay).toBeUndefined();
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const lastChild = await read_node(childIds.at(-1)!);
		expect(lastChild.archiveOperationId).not.toBeNull();
		expect(await read_doc(lastChild._id), "job-archived child").toMatchObject({
			archiveOperationId: lastChild.archiveOperationId,
		});
		expect(await read_doc(folderId)).toMatchObject({ archiveOperationId: lastChild.archiveOperationId });
		const archivedDocs = await t.run((ctx) => ctx.db.query("files_updated_by_docs").collect());
		expect(archivedDocs).toHaveLength(81);
		expect(
			archivedDocs.filter((doc) => doc.archiveOperationId !== lastChild.archiveOperationId),
			"docs left active",
		).toEqual([]);

		const restored = await asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folderId],
		});
		expect(restored._nay).toBeUndefined();
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await read_node(lastChild._id)).archiveOperationId).toBeNull();
		// `t.run` drops undefined fields, so an active doc has no `archiveOperationId` key.
		expect(await read_doc(lastChild._id), "restored child").not.toHaveProperty("archiveOperationId");
		expect(await read_doc(folderId)).not.toHaveProperty("archiveOperationId");
		const restoredDocs = await t.run((ctx) => ctx.db.query("files_updated_by_docs").collect());
		expect(
			restoredDocs.filter((doc) => doc.archiveOperationId !== undefined),
			"docs left archived",
		).toEqual([]);
	});

	test("restrict and unrestrict set the doc's flag", async () => {
		const { db, asOwner, create_folder, read_doc } = await fixture();
		const folderId = await create_folder("/restricted");

		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId,
			nodeId: folderId,
		});
		expect(restricted._nay).toBeUndefined();
		expect(await read_doc(folderId)).toMatchObject({ isRestrictedScopeRoot: true });

		const unrestricted = await asOwner.mutation(api.files_sharing.unrestrict_node, {
			membershipId: db.membershipId,
			nodeId: folderId,
		});
		expect(unrestricted._nay).toBeUndefined();
		expect(await read_doc(folderId)).toMatchObject({ isRestrictedScopeRoot: false });
	});

	test("an upload that replaces a file archives the old file's doc", async () => {
		const { db, asOwner, read_doc, read_node } = await fixture();
		const upload = (onConflict?: "replace") =>
			asOwner.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename: "scan.png",
				contentType: "image/png",
				size: 4096,
				onConflict,
			});
		const first = await upload();
		if (first._nay) throw new Error(first._nay.message);
		expect(await read_doc(first._yay.nodeId)).toMatchObject({ name: "scan.png", nodeKind: "file" });

		const second = await upload("replace");
		if (second._nay) throw new Error(second._nay.message);
		const replaced = await read_node(first._yay.nodeId);
		expect(replaced.archiveOperationId).not.toBeNull();
		expect(await read_doc(first._yay.nodeId), "replaced upload").toMatchObject({
			archiveOperationId: replaced.archiveOperationId,
		});
		expect(await read_doc(second._yay.nodeId)).toMatchObject({ name: "scan.png", parentId: files_ROOT_ID });
	});

	test("a node whose updater becomes SYSTEM loses its doc", async () => {
		const { t, create_folder, read_doc } = await fixture();
		const folderId = await create_folder("/system-owned");
		expect(await read_doc(folderId)).not.toBeNull();

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folderId, { updatedBy: users_SYSTEM_AUTHOR });
			await files_updated_by_db_sync_node(ctx, { nodeId: folderId });
		});
		expect(await read_doc(folderId)).toBeNull();
	});
});

describe("files_updated_by_docs cleanup", () => {
	test("hard delete removes the node's doc and keeps other nodes' docs", async () => {
		const { t, db, read_doc } = await fixture();
		const deletedNodeId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path: "/deleted.md" });
		const keptNodeId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path: "/kept.md" });
		expect(await read_doc(deletedNodeId)).not.toBeNull();

		await t.run((ctx) =>
			files_nodes_db_hard_delete_node(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId: deletedNodeId,
			}),
		);

		expect(await read_doc(deletedNodeId), "deleted node's doc").toBeNull();
		expect(await read_doc(keptNodeId)).toMatchObject({ fileNodeId: keptNodeId });
	});

	test("a workspace purge with a queued name drain leaves no docs", async () => {
		const { t, db, create_folder, rename_user, read_user_keys, drain } = await fixture({ displayName: "Mia" });
		await create_folder("/purged/inner");
		await rename_user("Nina");
		// Queued, not run: fake timers hold it until the purge is done.
		await t.run((ctx) => ctx.scheduler.runAfter(0, internal.files_updated_by.drain_user_name, { userId: db.userId }));

		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: db.userId,
				scope: "workspace",
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				eligibleAt: Date.now(),
			}),
		);
		for (let pass = 0; pass < 50; pass += 1) {
			const result = await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId });
			if (result.done) break;
		}
		expect(await read_user_keys(db.userId), "docs left after purge").toEqual([]);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_user_keys(db.userId), "docs after the queued drain").toEqual([]);
		expect(await drain()).toEqual({ patchedCount: 0 });
	});
});

describe("files_updated_by_docs name drain", () => {
	test("a rename drains 251 stale docs in batches of 100, then patches nothing", async () => {
		const { t, db, create_folder, rename_user, seed_docs, read_user_keys, drain } = await fixture({
			displayName: "Mia",
		});
		const folderId = await create_folder("/drained");
		const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		// Old keys on both sides of the new key. The folder's own doc is the 251st.
		await seed_docs({ templateNodeId: folderId, userId: db.userId, name: "Alice", count: 125 });
		await seed_docs({ templateNodeId: folderId, userId: db.userId, name: "Zed", count: 125 });
		await seed_docs({ templateNodeId: folderId, userId: otherUserId, name: "Alice", count: 3 });
		await rename_user("Nina");

		const batchCounts = [];
		for (let run = 0; run < 4; run += 1) {
			batchCounts.push((await drain({ _test_batchSize: 100, _test_disableReschedule: true })).patchedCount);
		}

		expect(batchCounts, "batch counts").toEqual([100, 100, 51, 0]);
		expect(new Set(await read_user_keys(db.userId))).toEqual(new Set([files_sort_text_key("Nina")]));
		expect(await read_user_keys(otherUserId), "other user's docs").toEqual(Array(3).fill(files_sort_text_key("Alice")));
	});

	test("each run schedules the next with the same batch size until nothing is stale", async () => {
		const { t, db, create_folder, rename_user, seed_docs, read_user_keys, drain, scheduled_drains } = await fixture({
			displayName: "Mia",
		});
		const folderId = await create_folder("/continued");
		await seed_docs({ templateNodeId: folderId, userId: db.userId, name: "Alice", count: 249 });
		await rename_user("Nina");

		expect(await drain({ _test_batchSize: 100 })).toEqual({ patchedCount: 100 });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		// Runs of 100, 100, 50 and 0: the first three schedule a next run, the last one stops.
		const jobs = await scheduled_drains();
		expect(jobs.map((job) => job.args[0])).toEqual(Array(3).fill({ userId: db.userId, _test_batchSize: 100 }));
		expect(new Set(await read_user_keys(db.userId))).toEqual(new Set([files_sort_text_key("Nina")]));
	});

	test("a second rename during the drain ends on the last name", async () => {
		const { db, create_folder, rename_user, seed_docs, read_user_keys, drain } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/renamed-twice");
		await seed_docs({ templateNodeId: folderId, userId: db.userId, name: "Alice", count: 249 });
		await rename_user("Nina");
		expect(await drain({ _test_batchSize: 100, _test_disableReschedule: true })).toEqual({ patchedCount: 100 });

		await rename_user("Zara");
		let patchedAfterRename = 0;
		for (let run = 0; run < 5; run += 1) {
			patchedAfterRename += (await drain({ _test_batchSize: 100, _test_disableReschedule: true })).patchedCount;
		}

		expect(patchedAfterRename).toBe(250);
		expect(new Set(await read_user_keys(db.userId))).toEqual(new Set([files_sort_text_key("Zara")]));
	});

	test("docs whose author changed or whose node was deleted leave the drain", async () => {
		const { t, db, create_folder, rename_user, read_doc, drain } = await fixture({ displayName: "Mia" });
		const movedId = await create_folder("/moved-author");
		const deletedId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path: "/deleted.md" });
		const keptId = await create_folder("/kept-author");
		const otherUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			const anagraphic = await ctx.db.insert("users_anagraphics", {
				userId,
				displayName: "Bob",
				email: "bob@example.com",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", userId, { anagraphic });
			return userId;
		});
		await rename_user("Nina");
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", movedId, { updatedBy: otherUserId });
			await files_updated_by_db_sync_node(ctx, { nodeId: movedId });
			await files_nodes_db_hard_delete_node(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId: deletedId,
			});
		});

		expect(await drain({ _test_disableReschedule: true })).toEqual({ patchedCount: 1 });
		expect(await read_doc(keptId)).toMatchObject({ sortUserName: files_sort_text_key("Nina") });
		expect(await read_doc(movedId)).toMatchObject({ userId: otherUserId, sortUserName: files_sort_text_key("Bob") });
		expect(await read_doc(deletedId)).toBeNull();
	});

	test("a write by the same updater keeps the old key until the drain reaches it", async () => {
		const { t, create_folder, rename_user, read_doc, drain } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/before-drain");
		await rename_user("Nina");

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folderId, { name: "after-write" });
			await files_updated_by_db_sync_node(ctx, { nodeId: folderId });
		});
		expect(await read_doc(folderId), "key before the drain").toMatchObject({
			name: "after-write",
			sortUserName: files_sort_text_key("Mia"),
		});

		await drain({ _test_disableReschedule: true });
		expect(await read_doc(folderId)).toMatchObject({ sortUserName: files_sort_text_key("Nina") });
	});

	test("two drains for the same rename end on the same keys", async () => {
		const { t, db, create_folder, rename_user, seed_docs, read_user_keys } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/duplicate-jobs");
		await seed_docs({ templateNodeId: folderId, userId: db.userId, name: "Alice", count: 30 });
		await rename_user("Nina");

		await t.run(async (ctx) => {
			await ctx.scheduler.runAfter(0, internal.files_updated_by.drain_user_name, { userId: db.userId });
			await ctx.scheduler.runAfter(0, internal.files_updated_by.drain_user_name, { userId: db.userId });
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(new Set(await read_user_keys(db.userId))).toEqual(new Set([files_sort_text_key("Nina")]));
	});

	test("a removed profile sorts as Unknown", async () => {
		const { create_folder, rename_user, read_doc, drain } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/profile-removed");

		await rename_user(null);
		expect(await drain({ _test_disableReschedule: true })).toEqual({ patchedCount: 1 });
		expect(await read_doc(folderId)).toMatchObject({ sortUserName: files_sort_text_key("Unknown") });
	});
});

describe("files_updated_by_docs name drain schedules", () => {
	test("a name change through resolve_user schedules the drain, and the same name does not", async () => {
		const { t, db, create_folder, read_doc, scheduled_drains } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/resolved");
		await t.run((ctx) => ctx.db.patch("users", db.userId, { clerkUserId: "clerk-updater" }));
		const resolve = (displayName: string) =>
			t.mutation(internal.users.resolve_user, {
				clerkUserId: "clerk-updater",
				email: "updater@example.com",
				displayName,
			});

		expect((await resolve("Mia"))._yay?.userId).toBe(db.userId);
		expect(await scheduled_drains(), "drains after the same name").toEqual([]);

		await resolve("Nina");
		expect((await scheduled_drains()).map((job) => job.args[0])).toEqual([{ userId: db.userId }]);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_doc(folderId)).toMatchObject({ sortUserName: files_sort_text_key("Nina") });
	});

	test("purging a deleted user's tombstone sorts their files as Unknown", async () => {
		const { t, db, create_folder, read_doc } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/tombstone");
		await t.run((ctx) => ctx.db.patch("users", db.userId, { deletedAt: Date.now() }));

		await t.mutation(internal.users.purge_deleted_user_tombstone, { userId: db.userId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await read_doc(folderId)).toMatchObject({ sortUserName: files_sort_text_key("Unknown") });
	});

	test("finalizing a deletion that removes the user record sorts their files as Unknown", async () => {
		const { t, db, create_folder, read_doc, scheduled_drains } = await fixture({ displayName: "Mia" });
		const folderId = await create_folder("/finalized");

		let finalized = false;
		for (let pass = 0; pass < 50 && !finalized; pass += 1) {
			finalized = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: db.userId,
				deleteUserAuth: true,
				deleteBillingState: true,
				deleteUserRecord: true,
			});
		}
		expect(await t.run((ctx) => ctx.db.get("users", db.userId))).toBeNull();
		expect((await scheduled_drains()).map((job) => job.args[0])).toEqual([{ userId: db.userId }]);

		// Run only the drain: finalization also schedules unrelated cleanup jobs.
		await t.mutation(internal.files_updated_by.drain_user_name, { userId: db.userId, _test_disableReschedule: true });
		expect(await read_doc(folderId)).toMatchObject({ sortUserName: files_sort_text_key("Unknown") });
	});
});
