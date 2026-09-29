import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

async function fixture() {
	const t = test_convex();
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const folderIds: Id<"files_nodes">[] = [];
	for (const path of ["/erase", "/keep"]) {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folderIds.push(created._yay.nodeId);
	}
	const expected = await t.run(async (ctx) => {
		for (const folderId of [files_ROOT_ID, ...folderIds]) {
			await ctx.db.insert("files_folder_sorts", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				folderId,
				sort: { field: "updated", direction: "desc" },
				updatedBy: scope.userId,
				updatedAt: 1,
			});
		}
		return await ctx.db.query("files_folder_sorts").collect();
	});
	return { t, scope, asOwner, folderIds, expected };
}

describe("erase_saved_sorts_for_multi_sort", () => {
	test("erases only expected saved sorts, including root and archived folders", async () => {
		const { t, scope, asOwner, folderIds, expected } = await fixture();
		const archived = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: scope.membershipId,
			nodeIds: [folderIds[0]!],
		});
		expect(archived._nay).toBeUndefined();
		const before = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", scope.userId),
			membership: await ctx.db.get("organizations_workspaces_users", scope.membershipId),
			folder: await ctx.db.get("files_nodes", folderIds[0]!),
		}));
		expect(before.folder!.archiveOperationId).not.toBeNull();
		const batch = expected.filter((sortDoc) => sortDoc.folderId === files_ROOT_ID || sortDoc.folderId === folderIds[0]);
		const result = await t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, {
			expected: batch,
		});
		expect(result).toEqual({ deletedIds: batch.map((sortDoc) => sortDoc._id), missingIds: [] });
		expect(await t.run((ctx) => ctx.db.query("files_folder_sorts").collect())).toEqual(
			expected.filter((sortDoc) => sortDoc.folderId === folderIds[1]),
		);
		expect(
			await t.run(async (ctx) => ({
				user: await ctx.db.get("users", scope.userId),
				membership: await ctx.db.get("organizations_workspaces_users", scope.membershipId),
				folder: await ctx.db.get("files_nodes", folderIds[0]!),
			})),
		).toEqual(before);
	});

	test("checks every doc before deleting when a later doc changed", async () => {
		const { t, expected } = await fixture();
		await t.run((ctx) => ctx.db.patch("files_folder_sorts", expected[1]!._id, { updatedAt: 2 }));
		await expect(
			t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, { expected }),
		).rejects.toThrow("Saved sort changed. Read it again before erasing.");
		expect(await t.run((ctx) => ctx.db.get("files_folder_sorts", expected[0]!._id))).toEqual(expected[0]);
		expect(await t.run((ctx) => ctx.db.get("files_folder_sorts", expected[1]!._id))).toEqual({ ...expected[1], updatedAt: 2 });
		expect(await t.run((ctx) => ctx.db.get("files_folder_sorts", expected[2]!._id))).toEqual(expected[2]);
	});

	test("refuses a changed clause even when its timestamp stayed the same", async () => {
		const { t, expected } = await fixture();
		const sort = { field: "created", direction: "asc" as const };
		await t.run((ctx) => ctx.db.patch("files_folder_sorts", expected[1]!._id, { sort }));
		await expect(
			t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, { expected }),
		).rejects.toThrow("Saved sort changed. Read it again before erasing.");
		expect(await t.run((ctx) => ctx.db.get("files_folder_sorts", expected[0]!._id))).toEqual(expected[0]);
		expect(await t.run((ctx) => ctx.db.get("files_folder_sorts", expected[1]!._id))).toEqual({ ...expected[1], sort });
	});

	test("reports missing ids on a retry and still erases the remaining checked docs", async () => {
		const { t, expected } = await fixture();
		await t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, { expected: expected.slice(0, 1) });
		expect(await t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, { expected })).toEqual({
			deletedIds: expected.slice(1).map((sortDoc) => sortDoc._id),
			missingIds: [expected[0]!._id],
		});
		expect(await t.run((ctx) => ctx.db.query("files_folder_sorts").collect())).toEqual([]);
	});

	test("refuses empty, oversized and duplicate batches without deleting", async () => {
		const { t, expected } = await fixture();
		for (const batch of [[], Array.from({ length: 51 }, () => expected[0]!)]) {
			await expect(
				t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, { expected: batch }),
			).rejects.toThrow("Choose 1 to 50 saved sort docs.");
		}
		await expect(
			t.mutation(internal.files_folder_sorts.erase_saved_sorts_for_multi_sort, { expected: [expected[0]!, expected[0]!] }),
		).rejects.toThrow("Choose each saved sort doc once.");
		expect(await t.run((ctx) => ctx.db.query("files_folder_sorts").collect())).toEqual(expected);
	});
});

describe("set_folder_sort cutover", () => {
	test("keeps saved docs fixed after the normal permission checks", async () => {
		const { t, scope, asOwner, folderIds, expected } = await fixture();
		const paused = await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId: files_ROOT_ID,
			sort: { field: "created", direction: "asc" },
		});
		expect(await t.run((ctx) => ctx.db.query("files_folder_sorts").collect())).toEqual(expected);
		expect(paused._nay?.message).toBe("Saved sorts are being reset. Try again soon.");
		await t.run((ctx) => ctx.db.patch("files_nodes", folderIds[0]!, { writePolicy: { mode: "read_only" } }));
		const refused = await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId: folderIds[0]!,
			sort: { field: "created", direction: "asc" },
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.query("files_folder_sorts").collect())).toEqual(expected);
	});
});
