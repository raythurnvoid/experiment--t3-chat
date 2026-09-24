import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

async function fixture() {
	const t = test_convex();
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });

	const create_folder = async (path: string) => {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};

	const viewer = await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk_folder_sort_viewer" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId,
			active: true,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId,
			role: "viewer",
			now,
		});
		return { userId, membershipId };
	});
	const asViewer = t.withIdentity({ issuer: "https://clerk.test", external_id: viewer.userId });

	const read_rows = () => t.run(async (ctx) => await ctx.db.query("files_folder_sorts").collect());

	return { t, scope, asOwner, viewer, asViewer, create_folder, read_rows };
}

describe("set_folder_sort", () => {
	test("a writer saves one folder's sort, every member reads it, and another folder stays on Name", async () => {
		const { scope, asOwner, viewer, asViewer, create_folder } = await fixture();
		const sortedId = await create_folder("/sorted");
		const otherId = await create_folder("/other");

		const saved = await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId: sortedId,
			sort: { field: "metadata.status", direction: "desc" },
		});
		expect(saved._nay).toBeUndefined();

		expect(
			await asViewer.query(api.files_folder_sorts.get_folder_sort, {
				membershipId: viewer.membershipId,
				folderId: sortedId,
			}),
		).toEqual({ sort: { field: "metadata.status", direction: "desc" }, canSave: false });
		expect(
			await asOwner.query(api.files_folder_sorts.get_folder_sort, {
				membershipId: scope.membershipId,
				folderId: otherId,
			}),
		).toEqual({ sort: { field: "name", direction: "asc" }, canSave: true });
	});

	test("the root has its own row, and saving Name A to Z deletes the row", async () => {
		const { scope, asOwner, read_rows } = await fixture();
		const save = (field: string, direction: "asc" | "desc") =>
			asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
				membershipId: scope.membershipId,
				folderId: files_ROOT_ID,
				sort: { field, direction },
			});

		expect((await save("updated", "desc"))._nay).toBeUndefined();
		expect((await save("size", "asc"))._nay).toBeUndefined();
		expect(await read_rows()).toEqual([
			expect.objectContaining({ folderId: files_ROOT_ID, sort: { field: "size", direction: "asc" } }),
		]);

		expect((await save("name", "asc"))._nay).toBeUndefined();
		expect(await read_rows()).toEqual([]);
	});

	test("a viewer cannot save, and the saved sort stays", async () => {
		const { scope, asOwner, viewer, asViewer, create_folder, read_rows } = await fixture();
		const folderId = await create_folder("/team");
		await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId,
			sort: { field: "created", direction: "desc" },
		});

		const refused = await asViewer.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: viewer.membershipId,
			folderId,
			sort: { field: "type", direction: "asc" },
		});
		expect(refused._nay?.message).toBe("Permission denied");
		expect(await read_rows()).toEqual([
			expect.objectContaining({ folderId, sort: { field: "created", direction: "desc" } }),
		]);
	});

	test("a read-only folder refuses a save and reports that nobody can save", async () => {
		const { t, scope, asOwner, create_folder, read_rows } = await fixture();
		const folderId = await create_folder("/locked");
		await t.run(async (ctx) => ctx.db.patch("files_nodes", folderId, { writePolicy: { mode: "read_only" } }));

		const refused = await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId,
			sort: { field: "updated", direction: "desc" },
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_rows()).toEqual([]);
		expect(
			await asOwner.query(api.files_folder_sorts.get_folder_sort, { membershipId: scope.membershipId, folderId }),
		).toEqual({ sort: { field: "name", direction: "asc" }, canSave: false });
	});

	test("refuses a field that cannot be sorted and a file in place of a folder", async () => {
		const { t, scope, asOwner, create_folder, read_rows } = await fixture();
		const folderId = await create_folder("/fields");

		const badField = await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId,
			sort: { field: "metadata.bad key", direction: "asc" },
		});
		expect(badField._nay?.message).toBe("This field cannot be sorted.");

		await t.run(async (ctx) => ctx.db.patch("files_nodes", folderId, { kind: "file" }));
		const notFolder = await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId,
			sort: { field: "updated", direction: "asc" },
		});
		expect(notFolder._nay?.message).toBe("Not found");
		expect(await read_rows()).toEqual([]);
	});
});

describe("get_folder_sort", () => {
	test("returns null for a restricted folder the member cannot read and for another workspace's folder", async () => {
		const { t, scope, asOwner, viewer, asViewer, create_folder } = await fixture();
		const folderId = await create_folder("/private");
		await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId,
			sort: { field: "updated", direction: "desc" },
		});
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: scope.membershipId,
			nodeId: folderId,
		});
		expect(restricted._nay).toBeUndefined();

		expect(
			await asViewer.query(api.files_folder_sorts.get_folder_sort, { membershipId: viewer.membershipId, folderId }),
		).toBeNull();

		const foreign = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);
		const asForeign = t.withIdentity({ issuer: "https://clerk.test", external_id: foreign.userId });
		expect(
			await asForeign.query(api.files_folder_sorts.get_folder_sort, {
				membershipId: foreign.membershipId,
				folderId,
			}),
		).toBeNull();
	});

	test("gives a member with no role the default root sort, not the saved one", async () => {
		const { t, scope, asOwner } = await fixture();
		await asOwner.mutation(api.files_folder_sorts.set_folder_sort, {
			membershipId: scope.membershipId,
			folderId: files_ROOT_ID,
			sort: { field: "metadata.status", direction: "desc" },
		});
		// No role means no workspace read. Such a member reads only what is shared with them.
		const grantOnly = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_folder_sort_grant_only" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			return { userId, membershipId };
		});
		const asGrantOnly = t.withIdentity({ issuer: "https://clerk.test", external_id: grantOnly.userId });

		expect(
			await asGrantOnly.query(api.files_folder_sorts.get_folder_sort, {
				membershipId: grantOnly.membershipId,
				folderId: files_ROOT_ID,
			}),
		).toEqual({ sort: { field: "name", direction: "asc" }, canSave: false });
	});

	test("throws without a signed-in user", async () => {
		const { t, scope } = await fixture();
		await expect(
			t.query(api.files_folder_sorts.get_folder_sort, { membershipId: scope.membershipId, folderId: files_ROOT_ID }),
		).rejects.toThrow("Unauthenticated");
	});
});
