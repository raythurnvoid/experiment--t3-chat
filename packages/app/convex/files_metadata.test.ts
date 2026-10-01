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
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
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
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, { ...owner, userId, role: "viewer", now: Date.now() });
		return { userId, membershipId };
	});
	const asViewer = t.withIdentity({ issuer: "https://clerk.test", external_id: viewer.userId });
	const child = (args: { name: string; entries?: files_metadata_Entry[]; folderId?: Id<"files_nodes"> }) => {
		const { name, entries = [], folderId = parentId } = args;

		return t.run(async (ctx) => {
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
		t.run((ctx) =>
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
	const private_text = async (text: string) => {
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...owner,
			path: "/table/draft.md",
			kind: "file",
		});
		if (created._nay) throw new Error(created._nay.message);
		const { target, pendingUpdateId, operationBatchId } = created._yay;
		if (!pendingUpdateId || !operationBatchId) throw new Error("Expected private text batch");
		for (const role of ["staged", "unstaged"] as const) {
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...owner,
				operationBatchId,
				role,
				text,
			});
			if (staged._nay) throw new Error(staged._nay.message);
		}
		const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			...owner,
			target,
			pendingUpdateId,
			operationBatchId,
		});
		if (ready._nay) throw new Error(ready._nay.message);
		return { target, pendingUpdateId };
	};
	const catalog = (afterField: string | null = null) =>
		asOwner.query(api.files_metadata.list_folder_fields, { membershipId: scope.membershipId, parentId, afterField });
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
		private_text,
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
						afterField: null,
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
					afterField: null,
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
	test("lists direct children beyond row 50 and excludes a sibling and descendants", async () => {
		const { t, owner, parentId, child, catalog } = await fixture();
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
		expect(parentId).toBeTruthy();
		expect(await catalog()).toEqual({ fields: ["metadata.late"], afterField: "metadata.late", isDone: true });
	});

	test("does not expose a hidden child's key or let it change a member's page", async () => {
		const { scope, asOwner, viewer, asViewer, parentId, child } = await fixture();
		await child({ name: "public.md", entries: [{ key: "public", value: true }] });
		const args = { membershipId: viewer.membershipId, parentId, afterField: null };
		const before = await asViewer.query(api.files_metadata.list_folder_fields, args);
		const hidden = await child({ name: "hidden.md", entries: [{ key: "hidden", value: "secret" }] });
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: scope.membershipId, nodeId: hidden }))
				._nay,
		).toBeUndefined();
		const after = await asViewer.query(api.files_metadata.list_folder_fields, args);
		expect(JSON.stringify(after)).not.toContain("metadata.hidden");
		expect(after).toEqual(before);
		expect(
			(await asOwner.query(api.files_metadata.list_folder_fields, { ...args, membershipId: scope.membershipId }))
				?.fields,
		).toEqual(["metadata.public"]);
	});

	test("fails on a stale field restriction flag instead of exposing the key", async () => {
		const { t, scope, asOwner, child, catalog } = await fixture();
		const nodeId = await child({ name: "hidden.md", entries: [{ key: "hidden", value: true }] });
		await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: scope.membershipId, nodeId });
		await t.run(async (ctx) => {
			const field = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", nodeId),
				)
				.filter((q) => q.eq(q.field("docKind"), "field"))
				.first();
			if (!field) throw new Error("Expected field");
			await ctx.db.patch("files_metadata_docs", field._id, { isRestrictedScopeRoot: false });
		});
		await expect(catalog()).rejects.toThrow("metadataDoc folder scope is mismatched");
	});

	test("returns an empty root for a grant-only member and null for an unreadable folder", async () => {
		const { t, viewer, asViewer, parentId } = await fixture();
		await t.run(async (ctx) => {
			const role = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_user_organization_workspace", (q) => q.eq("userId", viewer.userId))
				.first();
			if (role) await ctx.db.delete("access_control_role_assignments", role._id);
		});
		expect(
			await asViewer.query(api.files_metadata.list_folder_fields, {
				membershipId: viewer.membershipId,
				parentId: "root",
				afterField: null,
			}),
		).toEqual({ fields: [], afterField: null, isDone: true });
		expect(
			await asViewer.query(api.files_metadata.list_folder_fields, {
				membershipId: viewer.membershipId,
				parentId,
				afterField: null,
			}),
		).toBeNull();
	});

	test("returns empty for a readable archived or caller-hidden folder", async () => {
		const { t, owner, parentId, child, catalog } = await fixture();
		await child({ name: "value.md", entries: [{ key: "status", value: "open" }] });
		await t.run((ctx) => ctx.db.patch("files_nodes", parentId, { archiveOperationId: "archived" }));
		expect(await catalog()).toEqual({ fields: [], afterField: null, isDone: true });
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
		expect(await catalog()).toEqual({ fields: [], afterField: null, isDone: true });
	});

	test("pages distinct keys and advances across invalid keys", async () => {
		const { child, frontmatter, catalog } = await fixture();
		const node = await child({
			name: "fields.md",
			entries: Array.from({ length: 60 }, (_, i) => ({ key: `field_${String(i).padStart(2, "0")}`, value: i })),
		});
		await frontmatter(node, Array.from({ length: 50 }, (_, i) => `${"a".repeat(300)}${i}: true`).join("\n"));
		const first = await catalog();
		expect(first).toMatchObject({ fields: [], isDone: false });
		expect(first?.afterField).toContain("frontmatter.");
		const second = await catalog(first!.afterField);
		expect(second?.fields).toHaveLength(50);
		expect(second?.isDone).toBe(false);
		const last = await catalog(second!.afterField);
		expect(last?.fields).toHaveLength(10);
		expect(last?.isDone).toBe(true);
	});
});

describe("list_node_fields", () => {
	test("skips all 400 list items with one distinct key seek", async () => {
		const { child, frontmatter, asOwner, scope } = await fixture({ transactionLimits: { databaseQueries: 60 } });
		const nodeId = await child({ name: "list.md" });
		await frontmatter(nodeId, `items: [${Array.from({ length: 400 }, (_, i) => `item${i}`).join(", ")}]`);
		expect(
			await asOwner.query(api.files_metadata.list_node_fields, {
				membershipId: scope.membershipId,
				target: { kind: "saved", id: nodeId },
				cursor: null,
			}),
		).toMatchObject({ fields: ["frontmatter.items"], isDone: true, sourceToken: "committed" });
	});

	test("pages a private source and restarts after a revision change", async () => {
		const { t, scope, owner, asOwner, private_folder } = await fixture();
		const draft = await private_folder(
			Array.from({ length: 60 }, (_, i) => ({ key: `field_${String(i).padStart(2, "0")}`, value: i })),
		);
		const args = { membershipId: scope.membershipId, target: draft.target, cursor: null };
		const first = await asOwner.query(api.files_metadata.list_node_fields, args);
		expect(first?.fields).toHaveLength(50);
		expect(first?.isDone).toBe(false);
		expect(
			(await asOwner.query(api.files_metadata.list_node_fields, { ...args, cursor: first!.continueCursor }))?.fields,
		).toHaveLength(10);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_updates", draft.pendingUpdateId, {
				revision: 2,
				createIntent: { kind: "folder", metadata: [{ key: "changed", value: true }] },
			});
			await files_metadata_db_replace_pending(ctx, {
				...owner,
				target: draft.target,
				pendingUpdateId: draft.pendingUpdateId,
				proposalRevision: 2,
				path: "/table/draft",
				createMetadata: [{ key: "changed", value: true }],
			});
		});
		const changed = await asOwner.query(api.files_metadata.list_node_fields, {
			...args,
			cursor: first!.continueCursor,
		});
		expect(changed?.fields).toEqual(["metadata.changed"]);
		expect(changed?.sourceToken).not.toBe(first?.sourceToken);
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

	test("throws for a wrong-revision witness instead of skipping it", async () => {
		const { t, scope, asOwner, private_folder } = await fixture();
		const draft = await private_folder([{ key: "old", value: "secret" }]);
		await t.run((ctx) => ctx.db.patch("files_pending_updates", draft.pendingUpdateId, { revision: 2 }));
		await expect(
			asOwner.query(api.files_metadata.list_node_fields, {
				membershipId: scope.membershipId,
				target: draft.target,
				cursor: null,
			}),
		).rejects.toThrow("metadataDoc source is mismatched");
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
			preparing: false,
			isDone: true,
			sourceToken: "committed",
			values: fields.map((field, i) => ({ field, value: ["2026-09-29", null, false, null, "", false, 0][i] })),
		});
	});

	test("reads the first private primitive without collecting 400 list values", async () => {
		const { scope, asOwner, private_text } = await fixture({ transactionLimits: { databaseQueries: 80 } });
		const draft = await private_text(
			`---\nitems: [${Array.from({ length: 400 }, (_, i) => `item${i}`).join(", ")}]\n---\n`,
		);
		expect(
			await asOwner.query(api.files_metadata.get_field_values, {
				membershipId: scope.membershipId,
				target: draft.target,
				fields: ["frontmatter.items"],
				afterField: null,
			}),
		).toMatchObject({ preparing: false, values: [{ field: "frontmatter.items", value: "item0" }], isDone: true });
	});

	test.each(["missing intent", "text without content"])(
		"returns preparing without old values for %s",
		async (state) => {
			const { t, scope, asOwner, private_folder } = await fixture();
			const draft = await private_folder([{ key: "status", value: "old" }]);
			await t.run((ctx) =>
				ctx.db.patch("files_pending_updates", draft.pendingUpdateId, {
					createIntent:
						state === "missing intent"
							? undefined
							: {
									kind: "text",
									metadata: [],
									contentType: "text/markdown",
									textKind: "rich_text",
									collaborationEnabled: true,
								},
				}),
			);
			expect(
				await asOwner.query(api.files_metadata.get_field_values, {
					membershipId: scope.membershipId,
					target: draft.target,
					fields: ["metadata.status"],
					afterField: null,
				}),
			).toMatchObject({ preparing: true, values: [], isDone: true });
			expect(
				await asOwner.query(api.files_metadata.list_node_fields, {
					membershipId: scope.membershipId,
					target: draft.target,
					cursor: null,
				}),
			).toMatchObject({ fields: [], isDone: true });
		},
	);

	test("throws for old private values and never calls them missing", async () => {
		const { t, scope, asOwner, private_folder } = await fixture();
		const draft = await private_folder([{ key: "status", value: "old" }]);
		await t.run((ctx) => ctx.db.patch("files_pending_updates", draft.pendingUpdateId, { revision: 2 }));
		await expect(
			asOwner.query(api.files_metadata.get_field_values, {
				membershipId: scope.membershipId,
				target: draft.target,
				fields: ["metadata.status"],
				afterField: null,
			}),
		).rejects.toThrow("metadataDoc source is mismatched");
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

		const folderFields: string[] = [];
		afterField = null;
		for (let page = 0; page < 7; page++) {
			const result = await catalog(afterField);
			expect(result?.fields.length).toBeGreaterThan(0);
			expect(result?.afterField).not.toBe(afterField);
			folderFields.push(...result!.fields);
			afterField = result!.afterField;
			if (result!.isDone) break;
		}
		expect(folderFields).toEqual(fields);

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
		const { scope, asOwner, child, parentId } = await fixture({ transactionLimits: { bytesRead: 800_000 } });
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
		await expect(
			asOwner.query(api.files_metadata.list_folder_fields, {
				membershipId: scope.membershipId,
				parentId,
				afterField: null,
			}),
		).rejects.toThrow("Metadata read exceeded its work limit");
	});
});
