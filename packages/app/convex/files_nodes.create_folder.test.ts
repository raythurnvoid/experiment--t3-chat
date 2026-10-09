import { RateLimiter } from "@convex-dev/rate-limiter";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = async (path: string, parentId: Id<"files_nodes"> | "root" = files_ROOT_ID) => {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const readState = () =>
		t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			versions: await ctx.db.query("files_media_validation_versions").collect(),
		}));
	return { t, db, asOwner, folder, readState };
}

describe("create_folder_node", () => {
	test("creates every missing path part with folder fields and media versions", async () => {
		const { t, db, asOwner } = await fixture();
		const before = await t.run((ctx) => ctx.db.query("files_media_validation_versions").collect());
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "Notes/Projects/2026",
		});
		if (created._nay) throw new Error(created._nay.message);
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(nodes.map((node) => node.path)).toEqual(["/Notes", "/Notes/Projects", "/Notes/Projects/2026"]);
		for (const [index, node] of nodes.entries()) {
			expect(node).toMatchObject({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: index === 0 ? files_ROOT_ID : nodes[index - 1]!._id,
				kind: "folder",
				name: ["Notes", "Projects", "2026"][index],
				sortName: files_sort_text_key(node.name),
				treePath: `${node.path}/`,
				pathDepth: index + 1,
				lowercaseExtension: null,
				contentType: null,
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,
				newChildWritePolicy: null,
				archiveOperationId: null,
				createdBy: db.userId,
				updatedBy: db.userId,
			});
		}
		expect(nodes.at(-1)?._id).toBe(created._yay.nodeId);
		const after = await t.run((ctx) => ctx.db.query("files_media_validation_versions").collect());
		const beforeRevision = before.find((version) => version.workspaceId === db.workspaceId)?.revision ?? 0;
		expect(after.find((version) => version.workspaceId === db.workspaceId)?.revision).toBe(beforeRevision + 3);
	});

	test("reuses an existing prefix and preserves its metadata", async () => {
		const { t, db, asOwner, folder } = await fixture();
		const parentId = await folder("docs");
		await t.run(async (ctx) => {
			const parent = await ctx.db.get("files_nodes", parentId);
			if (!parent) throw new Error("Expected parent folder");
			await files_metadata_db_write_entries(ctx, {
				fileNode: parent,
				entries: [{ key: "status", value: "open" }],
			});
		});
		const metadataBefore = await t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
		const parentBefore = await t.run((ctx) => ctx.db.get("files_nodes", parentId));
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "docs/a/b",
		});
		expect(created._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", parentId))).toEqual(parentBefore);
		expect(await t.run((ctx) => ctx.db.query("files_metadata_docs").collect())).toEqual(metadataBefore);
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(nodes.map((node) => node.path)).toEqual(["/docs", "/docs/a", "/docs/a/b"]);
		expect(nodes[1]?.parentId).toBe(parentId);
	});

	test.each(["duplicate folder", "file prefix", "file parent", "archived parent"] as const)(
		"refuses %s without partial writes",
		async (kind) => {
			const { t, db, asOwner, folder, readState } = await fixture();
			const parentId = await folder("docs");
			if (kind === "file prefix" || kind === "file parent") {
				await t.run((ctx) => ctx.db.patch("files_nodes", parentId, { kind: "file", treePath: "/docs" }));
			}
			if (kind === "archived parent") {
				await t.run((ctx) => ctx.db.patch("files_nodes", parentId, { archiveOperationId: "archived-test" }));
			}
			const before = await readState();
			const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: kind === "file parent" || kind === "archived parent" ? parentId : files_ROOT_ID,
				path: kind === "duplicate folder" ? "docs" : kind === "file prefix" ? "docs/a/b" : "a/b",
			});
			expect(created._nay?.message).toBe(
				kind === "file parent" || kind === "archived parent" ? "Not found" : "This folder already exists.",
			);
			expect(await readState()).toEqual(before);
		},
	);

	test.each(["read only", "matching writer", "other writer"] as const)(
		"checks the destination rule: %s",
		async (rule) => {
			const { t, db, asOwner, folder, readState } = await fixture();
			const parentId = await folder("docs");
			const otherId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "other_writer" }));
			await t.run((ctx) =>
				ctx.db.patch("files_nodes", parentId, {
					writePolicy:
						rule === "read only"
							? { mode: "read_only" }
							: {
									mode: "writer",
									writers: [{ kind: "user", userId: rule === "matching writer" ? db.userId : otherId }],
								},
				}),
			);
			const before = await readState();
			const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: "docs/a/b",
			});
			if (rule === "matching writer") {
				expect(created._nay).toBeUndefined();
				expect((await readState()).nodes).toHaveLength(before.nodes.length + 2);
			} else {
				expect(created._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });
				expect(await readState()).toEqual(before);
			}
		},
	);

	test("copies the parent's default onto every missing folder without changing old children", async () => {
		const { t, db, asOwner, folder } = await fixture();
		const parentId = await folder("docs");
		const oldChildId = await folder("old", parentId);
		const policy = { mode: "read_only" } as const;
		const changed = await asOwner.mutation(api.files_nodes.set_node_new_child_write_policy, {
			membershipId: db.membershipId,
			nodeId: parentId,
			newChildWritePolicy: policy,
		});
		expect(changed._nay).toBeUndefined();
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path: "a/b",
		});
		expect(created._nay).toBeUndefined();
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		for (const node of nodes.filter((node) => node.path === "/docs/a" || node.path === "/docs/a/b")) {
			expect(node.writePolicy).toEqual(policy);
			expect(node.newChildWritePolicy).toEqual(policy);
		}
		expect(nodes.find((node) => node._id === oldChildId)?.writePolicy).toBeNull();
	});

	test("a restricted-folder grant allows nested creates and preserves the scope", async () => {
		const { t, db, asOwner, folder, readState } = await fixture();
		const parentId = await folder("shared");
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "folder_viewer" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, { ...db, userId, role: "viewer", now: Date.now() });
			return { userId, membershipId };
		});
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId,
			nodeId: parentId,
		});
		expect(restricted._nay).toBeUndefined();
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		const before = await readState();
		const hidden = await asMember.mutation(api.files_nodes.create_folder_node, {
			membershipId: member.membershipId,
			parentId,
			path: "a/b",
		});
		expect(hidden._nay?.message).toBe("Permission denied");
		expect(await readState()).toEqual(before);
		const granted = await asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: db.membershipId,
			nodeId: parentId,
			principal: { kind: "user", userId: member.userId },
			level: "write",
		});
		expect(granted._nay).toBeUndefined();
		const rootRefused = await asMember.mutation(api.files_nodes.create_folder_node, {
			membershipId: member.membershipId,
			parentId: files_ROOT_ID,
			path: "outside",
		});
		expect(rootRefused._nay?.message).toBe("Permission denied");
		const created = await asMember.mutation(api.files_nodes.create_folder_node, {
			membershipId: member.membershipId,
			parentId,
			path: "a/b",
		});
		expect(created._nay).toBeUndefined();
		const nodes = (await readState()).nodes.filter((node) => node.path.startsWith("/shared/"));
		expect(nodes).toHaveLength(2);
		for (const node of nodes) {
			expect(node.restrictedScopeNodeId).toBe(parentId);
			expect(node.isRestrictedScopeRoot).toBe(false);
			expect(node.createdBy).toBe(member.userId);
		}
	});

	test.each(["no identity", "inactive", "pending removal", "other user"] as const)(
		"refuses unavailable membership: %s",
		async (state) => {
			const { t, db, asOwner, readState } = await fixture();
			if (state === "inactive") {
				await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
			}
			if (state === "pending removal") {
				await t.run((ctx) =>
					ctx.db.patch("organizations_workspaces_users", db.membershipId, { pendingOrganizationRemoval: true }),
				);
			}
			if (state === "other user") {
				const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "other_member" }));
				await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { userId }));
			}
			const before = await readState();
			const result = await (state === "no identity" ? t : asOwner).mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: "a/b",
			});
			expect(result._nay?.message).toBe(
				state === "no identity"
					? "Unauthenticated"
					: state === "pending removal"
						? "Permission denied"
						: "Unauthorized",
			);
			expect(await readState()).toEqual(before);
		},
	);

	test("uses the shared tree-write rate limit", async () => {
		const { db, asOwner, readState } = await fixture();
		const before = await readState();
		const limit = vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: false, retryAfter: 1000 });
		const result = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "a/b",
		});
		expect(result._nay).toBeDefined();
		expect(limit).toHaveBeenCalledWith(expect.anything(), "files_tree_write", { key: db.userId, count: undefined });
		expect(await readState()).toEqual(before);
	});
});
