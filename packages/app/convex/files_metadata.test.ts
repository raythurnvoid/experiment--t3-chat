import { describe, expect, test } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	files_metadata_db_insert_committed,
	files_metadata_db_replace_pending,
	files_metadata_db_write_entries,
} from "./files_metadata.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import type { files_metadata_Entry } from "../shared/files-metadata.ts";

async function fixture(options: Parameters<typeof test_convex>[0] = { transactionLimits: true }) {
	const t = test_convex(options);
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const owner = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, userId: scope.userId };
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...owner, path: "/table" });
	if (created._nay) throw new Error(created._nay.message);
	const parentId = created._yay.nodeId;
	const viewer = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk_metadata_viewer" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, { ...owner, userId, role: "viewer", now: Date.now() });
		return { userId, membershipId };
	});
	const asViewer = t.withIdentity({ issuer: "https://clerk.test", external_id: viewer.userId });
	const child = (args: { name: string; entries?: files_metadata_Entry[]; folderId?: Id<"files_nodes"> }) => {
		const { name, entries = [], folderId = parentId } = args;

		return test_run_with_flush(t, async (ctx) => {
			const parent = await ctx.db.get("files_nodes", folderId);
			if (!parent) throw new Error("Expected parent");
			const path = `${parent.path}/${name}`;
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				parentId: folderId,
				name,
				sortName: files_sort_text_key(name),
				kind: "file",
				path,
				treePath: path,
				pathDepth: 2,
			});
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!fileNode) throw new Error("Expected child");
			await files_metadata_db_write_entries(ctx, { fileNode, entries });
			return nodeId;
		});
	};
	const frontmatter = (nodeId: Id<"files_nodes">, yaml: string) =>
		test_run_with_flush(t, (ctx) =>
			files_metadata_db_insert_committed(ctx, { ...owner, nodeId, markdownContent: `---\n${yaml}\n---\n` }),
		);
	const private_folder = (entries: files_metadata_Entry[] = []) =>
		t.run(async (ctx) => {
			const created = await files_pending_nodes_db_create(ctx, {
				...owner,
				parent: { kind: "saved", id: parentId },
				name: "draft",
				kind: "folder",
			});
			if (created._nay) throw new Error(created._nay.message);
			await ctx.db.patch("files_pending_updates", created._yay.pendingUpdateId, {
				createIntent: { kind: "folder", metadata: entries },
			});
			await files_metadata_db_replace_pending(ctx, {
				...owner,
				target: { kind: "private", id: created._yay.privateNodeId },
				pendingUpdateId: created._yay.pendingUpdateId,
				proposalRevision: 1,
				path: "/table/draft",
				createMetadata: entries,
			});
			return { ...created._yay, target: { kind: "private" as const, id: created._yay.privateNodeId } };
		});
	const catalog = async (prefix = "", cursor: string | null = null) => {
		await test_compact_metadata_catalog(t);
		return await asOwner.query(api.files_metadata.list_folder_fields, {
			membershipId: scope.membershipId,
			parentId,
			prefix,
			paginationOpts: { numItems: 50, cursor },
		});
	};
	return {
		t,
		scope,
		owner,
		asOwner,
		viewer,
		asViewer,
		parentId,
		child,
		frontmatter,
		private_folder,
		catalog,
	};
}

describe("table metadata caller", () => {
	test.each([true, false])(
		"each new table metadata door throws Unauthenticated for a stale missing caller (membership active=%s)",
		async (active) => {
			const { t, scope, asOwner, parentId } = await fixture();
			await t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", scope.membershipId, { active });
				await ctx.db.delete("users", scope.userId);
			});
			const asAnonymous = t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: scope.userId });
			for (const asCaller of [asOwner, asAnonymous]) {
				await expect(
					asCaller.query(api.files_metadata.list_folder_fields, {
						membershipId: scope.membershipId,
						parentId,
						prefix: "",
						paginationOpts: { numItems: 50, cursor: null },
					}),
				).rejects.toThrow("Unauthenticated");
				await expect(
					asCaller.query(api.files_metadata.list_node_fields, {
						membershipId: scope.membershipId,
						target: { kind: "saved", id: parentId },
						cursor: null,
					}),
				).rejects.toThrow("Unauthenticated");
				await expect(
					asCaller.query(api.files_metadata.get_field_values, {
						membershipId: scope.membershipId,
						target: { kind: "saved", id: parentId },
						fields: ["metadata.status"],
						afterField: null,
					}),
				).rejects.toThrow("Unauthenticated");
			}
		},
	);

	test.each([true, false])(
		"each new table metadata door throws Unauthenticated for an anonymous tombstone (membership active=%s)",
		async (active) => {
			const { t, scope, parentId } = await fixture();
			await t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", scope.membershipId, { active });
				await ctx.db.patch("users", scope.userId, { clerkUserId: null, deletedAt: Date.now() });
			});
			const asAnonymous = t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: scope.userId });
			await expect(
				asAnonymous.query(api.files_metadata.list_folder_fields, {
					membershipId: scope.membershipId,
					parentId,
					prefix: "",
					paginationOpts: { numItems: 50, cursor: null },
				}),
			).rejects.toThrow("Unauthenticated");
			await expect(
				asAnonymous.query(api.files_metadata.list_node_fields, {
					membershipId: scope.membershipId,
					target: { kind: "saved", id: parentId },
					cursor: null,
				}),
			).rejects.toThrow("Unauthenticated");
			await expect(
				asAnonymous.query(api.files_metadata.get_field_values, {
					membershipId: scope.membershipId,
					target: { kind: "saved", id: parentId },
					fields: ["metadata.status"],
					afterField: null,
				}),
			).rejects.toThrow("Unauthenticated");
		},
	);
});

describe("list_folder_fields", () => {
	const refused = { page: [], isDone: true, continueCursor: "" };

	test("lists direct children beyond row 50 and excludes a sibling and descendants", async () => {
		const { t, owner, child, catalog } = await fixture();
		for (let i = 0; i < 51; i++)
			await child({ name: `child-${i}.md`, entries: i === 50 ? [{ key: "late", value: true }] : [] });
		for (const path of ["/other", "/table/nested"]) {
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...owner, path });
			if (created._nay) throw new Error(created._nay.message);
			await child({
				name: "unique.md",
				entries: [{ key: path === "/other" ? "sibling" : "descendant", value: true }],
				folderId: created._yay.nodeId,
			});
		}
		expect((await catalog()).page).toEqual(["metadata.late"]);
	});

	test("lists the keys of restricted children to every member (user, 2026-10-08)", async () => {
		const { scope, asOwner, viewer, asViewer, parentId, child, catalog } = await fixture();
		await child({ name: "public.md", entries: [{ key: "public", value: true }] });
		const hidden = await child({ name: "hidden.md", entries: [{ key: "hidden", value: "secret" }] });
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: scope.membershipId, nodeId: hidden }))
				._nay,
		).toBeUndefined();
		expect((await catalog()).page).toEqual(["metadata.hidden", "metadata.public"]);
		expect(
			(
				await asViewer.query(api.files_metadata.list_folder_fields, {
					membershipId: viewer.membershipId,
					parentId,
					prefix: "",
					paginationOpts: { numItems: 50, cursor: null },
				})
			).page,
		).toEqual(["metadata.hidden", "metadata.public"]);
	});

	test("a prefix ignores case, keeps index order, and pages", async () => {
		const { child, catalog } = await fixture();
		// U+FF58 comes before U+1D465 in the index, but JS `<` compares UTF-16 units and puts the
		// surrogate pair of U+1D465 first.
		await child({
			name: "keys.md",
			entries: [
				{ key: "Bravo", value: 1 },
				{ key: "alpha", value: 1 },
				{ key: "\u{FF58}", value: 1 },
				{ key: "\u{1D465}", value: 1 },
				...Array.from({ length: 60 }, (_, i) => ({ key: `field_${String(i).padStart(2, "0")}`, value: i })),
			],
		});
		expect((await catalog("METADATA.b")).page).toEqual(["metadata.Bravo"]);
		expect((await catalog("metadata.\u{FF58}")).page).toEqual(["metadata.\u{FF58}"]);
		const first = await catalog("metadata.");
		expect(first.page).toHaveLength(50);
		const second = await catalog("metadata.", first.continueCursor);
		expect([...first.page, ...second.page]).toEqual([
			"metadata.alpha",
			"metadata.Bravo",
			...Array.from({ length: 60 }, (_, i) => `metadata.field_${String(i).padStart(2, "0")}`),
			"metadata.\u{FF58}",
			"metadata.\u{1D465}",
		]);
		expect(second.isDone).toBe(true);
		// No key is longer than 160 characters.
		expect(await catalog("m".repeat(161))).toEqual(refused);
	});

	test("gives one empty page to every folder it refuses", async () => {
		const { t, scope, viewer, asViewer, parentId, child } = await fixture();
		const fileId = await child({ name: "file.md", entries: [{ key: "status", value: "open" }] });
		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org" }));
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: other.organizationId,
			workspaceId: other.workspaceId,
			userId: other.userId,
			path: "/foreign",
		});
		if (created._nay) throw new Error(created._nay.message);
		const read = (membershipId: Id<"organizations_workspaces_users">, folderId: Id<"files_nodes"> | "root") =>
			asViewer.query(api.files_metadata.list_folder_fields, {
				membershipId,
				parentId: folderId,
				prefix: "",
				paginationOpts: { numItems: 50, cursor: null },
			});
		const deletedId = await t.run(async (ctx) => {
			const { _id, _creationTime, ...folder } = (await ctx.db.get("files_nodes", parentId))!;
			const id = await ctx.db.insert("files_nodes", folder);
			await ctx.db.delete("files_nodes", id);
			return id;
		});
		for (const folderId of [fileId, created._yay.nodeId, deletedId]) expect(await read(viewer.membershipId, folderId)).toEqual(refused);
		// Somebody else's membership.
		expect(await read(scope.membershipId, parentId)).toEqual(refused);

		// A grant-only member reads neither the root nor an unshared folder.
		await t.run(async (ctx) => {
			const role = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_user_organization_workspace", (q) => q.eq("userId", viewer.userId))
				.first();
			if (role) await ctx.db.delete("access_control_role_assignments", role._id);
		});
		expect(await read(viewer.membershipId, "root")).toEqual(refused);
		expect(await read(viewer.membershipId, parentId)).toEqual(refused);
	});

	test("returns empty for a readable archived folder and ignores the caller's draft delete", async () => {
		const { t, owner, parentId, child, catalog } = await fixture();
		await child({ name: "value.md", entries: [{ key: "status", value: "open" }] });
		await t.run((ctx) => ctx.db.patch("files_nodes", parentId, { archiveOperationId: "archived" }));
		expect(await catalog()).toEqual(refused);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", parentId, { archiveOperationId: null });
			await ctx.db.insert("files_pending_updates", {
				...owner,
				target: { kind: "saved", id: parentId },
				revision: 1,
				updatedAt: Date.now(),
				expiresAt: Date.now() + 1000,
				size: 0,
				pendingArchive: { fromPath: "/table" },
			});
		});
		expect((await catalog()).page).toEqual(["metadata.status"]);
	});

	test("leaves out keys the search grammar cannot name", async () => {
		const { child, frontmatter, catalog } = await fixture();
		const node = await child({ name: "fields.md", entries: [{ key: "status", value: 1 }] });
		await frontmatter(node, Array.from({ length: 50 }, (_, i) => `${"a".repeat(300)}${i}: true`).join("\n"));
		expect(await catalog()).toMatchObject({ page: ["metadata.status"], isDone: true });
	});
});

describe("list_node_fields", () => {
	test("skips all 400 list items with one distinct key seek", async () => {
		const { t, owner, child, asOwner, scope } = await fixture({ transactionLimits: { databaseQueries: 60 } });
		const nodeId = await child({ name: "list.md" });
		// The cap is for the query below. A raw write keeps the setup out of the write wrappers, and this
		// door reads the docs, not the catalog.
		await t.run((ctx) =>
			files_metadata_db_insert_committed(ctx, {
				...owner,
				nodeId,
				markdownContent: `---\nitems: [${Array.from({ length: 400 }, (_, i) => `item${i}`).join(", ")}]\n---\n`,
			}),
		);
		expect(
			await asOwner.query(api.files_metadata.list_node_fields, {
				membershipId: scope.membershipId,
				target: { kind: "saved", id: nodeId },
				cursor: null,
			}),
		).toMatchObject({ fields: ["frontmatter.items"], isDone: true });
	});

	test("returns null for the caller's own private draft", async () => {
		const { scope, asOwner, private_folder } = await fixture();
		const draft = await private_folder([{ key: "status", value: "draft" }]);
		expect(
			await asOwner.query(api.files_metadata.list_node_fields, {
				membershipId: scope.membershipId,
				target: draft.target,
				cursor: null,
			}),
		).toBeNull();
		expect(
			await asOwner.query(api.files_metadata.get_field_values, {
				membershipId: scope.membershipId,
				target: draft.target,
				fields: ["metadata.status"],
				afterField: null,
			}),
		).toBeNull();
	});

	test("rejects a cursor from another target", async () => {
		const { scope, asOwner, child } = await fixture();
		const one = await child({ name: "one.md", entries: [{ key: "one", value: 1 }] });
		const two = await child({ name: "two.md", entries: [{ key: "two", value: 2 }] });
		const first = await asOwner.query(api.files_metadata.list_node_fields, {
			membershipId: scope.membershipId,
			target: { kind: "saved", id: one },
			cursor: null,
		});
		await expect(
			asOwner.query(api.files_metadata.list_node_fields, {
				membershipId: scope.membershipId,
				target: { kind: "saved", id: two },
				cursor: first!.continueCursor,
			}),
		).rejects.toThrow("Invalid field cursor");
	});
});

describe("get_field_values", () => {
	test("preserves typed false, zero, empty strings, first list values, and missing parents", async () => {
		const { scope, asOwner, child, frontmatter } = await fixture();
		const nodeId = await child({
			name: "values.md",
			entries: [
				{ key: "zero", value: 0 },
				{ key: "false", value: false },
				{ key: "empty", value: "" },
			],
		});
		await frontmatter(nodeId, "date: 2026-09-29\nitems: [false, 2]\nmap: {child: 3}\nempty: []");
		const fields = [
			"frontmatter.date",
			"frontmatter.empty",
			"frontmatter.items",
			"frontmatter.map",
			"metadata.empty",
			"metadata.false",
			"metadata.zero",
		];
		const result = await asOwner.query(api.files_metadata.get_field_values, {
			membershipId: scope.membershipId,
			target: { kind: "saved", id: nodeId },
			fields,
			afterField: null,
		});
		expect(result).toMatchObject({
			isDone: true,
			values: fields.map((field, i) => ({ field, value: ["2026-09-29", null, false, null, "", false, 0][i] })),
		});
	});

	test("keeps committed frontmatter while the owner has a pending content edit", async () => {
		const { t, scope, owner, asOwner, child, frontmatter } = await fixture();
		const nodeId = await child({ name: "saved.md" });
		await frontmatter(nodeId, "status: committed");
		await t.run(async (ctx) => {
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				...owner,
				target: { kind: "saved", id: nodeId },
				revision: 1,
				updatedAt: Date.now(),
				expiresAt: Date.now() + 1000,
				size: 0,
			});
			await files_metadata_db_replace_pending(ctx, {
				...owner,
				target: { kind: "saved", id: nodeId },
				pendingUpdateId,
				proposalRevision: 1,
				path: "/table/saved.md",
				unstagedText: "---\nstatus: pending\n---\n",
			});
		});
		expect(
			(
				await asOwner.query(api.files_metadata.get_field_values, {
					membershipId: scope.membershipId,
					target: { kind: "saved", id: nodeId },
					fields: ["frontmatter.status"],
					afterField: null,
				})
			)?.values,
		).toEqual([{ field: "frontmatter.status", value: "committed" }]);
	});

	test("returns null for a hidden target, grants access, then removes it on revocation", async () => {
		const { scope, asOwner, viewer, asViewer, child } = await fixture();
		const nodeId = await child({ name: "hidden.md", entries: [{ key: "status", value: "secret" }] });
		await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: scope.membershipId, nodeId });
		const args = {
			membershipId: viewer.membershipId,
			target: { kind: "saved" as const, id: nodeId },
			fields: ["metadata.status"],
			afterField: null,
		};
		expect(await asViewer.query(api.files_metadata.get_field_values, args)).toBeNull();
		expect(
			await asViewer.query(api.files_metadata.list_node_fields, {
				membershipId: viewer.membershipId,
				target: args.target,
				cursor: null,
			}),
		).toBeNull();
		const grant = {
			membershipId: scope.membershipId,
			nodeId,
			principal: { kind: "user" as const, userId: viewer.userId },
			level: "read" as const,
		};
		expect((await asOwner.mutation(api.files_sharing.set_node_share_grant, grant))._nay).toBeUndefined();
		expect((await asViewer.query(api.files_metadata.get_field_values, args))?.values).toEqual([
			{ field: "metadata.status", value: "secret" },
		]);
		await asOwner.mutation(api.files_sharing.remove_node_share_grant, {
			membershipId: grant.membershipId,
			nodeId,
			principal: grant.principal,
		});
		expect(await asViewer.query(api.files_metadata.get_field_values, args)).toBeNull();
	});

	test("refuses another owner, tenant, inactive membership, and unauthenticated caller", async () => {
		const { t, scope, asOwner, viewer, asViewer, child, private_folder } = await fixture();
		const draft = await private_folder([{ key: "status", value: "private" }]);
		expect(
			await asViewer.query(api.files_metadata.get_field_values, {
				membershipId: viewer.membershipId,
				target: draft.target,
				fields: ["metadata.status"],
				afterField: null,
			}),
		).toBeNull();
		const nodeId = await child({ name: "scoped.md", entries: [{ key: "status", value: true }] });
		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "foreign" }));
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		const args = {
			membershipId: scope.membershipId,
			target: { kind: "saved" as const, id: nodeId },
			fields: ["metadata.status"],
			afterField: null,
		};
		expect(
			await asOther.query(api.files_metadata.get_field_values, { ...args, membershipId: other.membershipId }),
		).toBeNull();
		expect(await asOther.query(api.files_metadata.get_field_values, args)).toBeNull();
		await expect(t.query(api.files_metadata.get_field_values, args)).rejects.toThrow("Unauthenticated");
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", scope.membershipId, { active: false }));
		expect(await asOwner.query(api.files_metadata.get_field_values, args)).toBeNull();
	});

	test.each(
		[
			[],
			["name"],
			["metadata.status", "metadata.status"],
			["metadata.z", "metadata.a"],
			Array.from({ length: 8 }, (_, i) => `metadata.field${i}`),
		].map((fields) => ({ fields })),
	)("rejects invalid selected fields $fields", async ({ fields }) => {
		const { scope, asOwner, child } = await fixture();
		const nodeId = await child({ name: "args.md" });
		await expect(
			asOwner.query(api.files_metadata.get_field_values, {
				membershipId: scope.membershipId,
				target: { kind: "saved", id: nodeId },
				fields,
				afterField: null,
			}),
		).rejects.toThrow("Invalid metadata fields");
	});

	test("rejects a value cursor outside the selected fields", async () => {
		const { scope, asOwner, child } = await fixture();
		const nodeId = await child({ name: "args.md" });
		await expect(
			asOwner.query(api.files_metadata.get_field_values, {
				membershipId: scope.membershipId,
				target: { kind: "saved", id: nodeId },
				fields: ["metadata.status"],
				afterField: "metadata.other",
			}),
		).rejects.toThrow("Invalid metadata fields");
	});

	test("splits large copied paths without skipping a requested field", async () => {
		const { scope, asOwner, child, catalog } = await fixture();
		const fields = Array.from({ length: 7 }, (_, i) => `metadata.field${i}`);
		const nodeId = await child({
			name: `${"x".repeat(180_000)}.md`,
			entries: fields.map((field, i) => ({ key: field.slice(9), value: i })),
		});
		let afterField: string | null = null;
		const values: Array<{ field: string; value: string | number | boolean | null }> = [];
		let pages = 0;
		for (; pages < 7; pages++) {
			const result: FunctionReturnType<typeof api.files_metadata.get_field_values> = await asOwner.query(
				api.files_metadata.get_field_values,
				{ membershipId: scope.membershipId, target: { kind: "saved", id: nodeId }, fields, afterField },
			);
			expect(result?.values.length).toBeGreaterThan(0);
			expect(result?.afterField).not.toBe(afterField);
			values.push(...result!.values);
			afterField = result!.afterField;
			if (result!.isDone) break;
		}
		expect(pages).toBeGreaterThan(0);
		expect(values).toEqual(fields.map((field, i) => ({ field, value: i })));

		expect((await catalog()).page).toEqual(fields);

		const nodeFields: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 7; page++) {
			const result: FunctionReturnType<typeof api.files_metadata.list_node_fields> = await asOwner.query(
				api.files_metadata.list_node_fields,
				{ membershipId: scope.membershipId, target: { kind: "saved", id: nodeId }, cursor },
			);
			expect(result?.fields.length).toBeGreaterThan(0);
			expect(result?.continueCursor).not.toBe(cursor);
			nodeFields.push(...result!.fields);
			cursor = result!.continueCursor;
			if (result!.isDone) break;
		}
		expect(nodeFields).toEqual(fields);
	});

	test("fails clearly when auth leaves no headroom for the first field", async () => {
		const { scope, asOwner, child } = await fixture({ transactionLimits: { bytesRead: 800_000 } });
		const nodeId = await child({ name: "budget.md", entries: [{ key: "status", value: true }] });
		const target = { kind: "saved" as const, id: nodeId };
		await expect(
			asOwner.query(api.files_metadata.get_field_values, {
				membershipId: scope.membershipId,
				target,
				fields: ["metadata.status"],
				afterField: null,
			}),
		).rejects.toThrow("Metadata read exceeded its work limit");
		await expect(
			asOwner.query(api.files_metadata.list_node_fields, { membershipId: scope.membershipId, target, cursor: null }),
		).rejects.toThrow("Metadata read exceeded its work limit");
	});
});
