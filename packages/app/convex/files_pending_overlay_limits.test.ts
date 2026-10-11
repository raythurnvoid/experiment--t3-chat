// Measure the private Discard core, hard delete, the metadata catalog and content Save, including
// the pending overlay flush. Paged Move and Accept cohort steps are in the .move and .accept files.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { files_nodes_db_rebuild_node } from "./files_nodes.ts";
import { compact_metadata_catalog } from "./files_pending_overlay.ts";
import { test_convex, test_mocks_fill_db_with, test_run_with_flush, test_spy_handler } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	add_member,
	budget_recorder,
	expect_under_convex_limits,
	insert_saved_node,
	mock_overlay_limits_storage,
	share_100_times,
	transaction_cost,
} from "./files_pending_overlay_limits.setup.test.ts";

beforeEach(mock_overlay_limits_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("discard_file_pending_update", () => {
	test("discards a 256-node private folder that claims a saved name", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

		await t.run(async (ctx) => {
			await insert_saved_node(ctx, db, { parent: null, name: "area", kind: "folder" });
		});
		// A single Discard answers `needs_review` for a private child folder, a child file with content,
		// or a draft move into the tree. So the largest tree it removes is one folder with 255 new, empty
		// files.
		for (let index = 0; index < 255; index++) {
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: `/area/drafts/note-${index}.md`,
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
		}
		// Another user then saves `/area/drafts` with files. The owner's private folder now claims that name.
		await t.run(async (ctx) => {
			const area = (await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/area")!;
			const other = await add_member(ctx, db, "clerk_discard_other");
			const claimed = await insert_saved_node(ctx, db, {
				parent: area,
				name: "drafts",
				kind: "folder",
				createdBy: other,
			});
			for (let index = 0; index < 10; index++)
				await insert_saved_node(ctx, db, {
					parent: claimed,
					name: `note-${index}.md`,
					kind: "file",
					createdBy: other,
				});
		});
		const root = await t.run(async (ctx) => {
			const node = (await ctx.db.query("files_pending_nodes").collect()).find((node) => node.name === "drafts")!;
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", node._id),
				)
				.unique();
			return { node, proposal: proposal! };
		});
		expect(await t.run(async (ctx) => (await ctx.db.query("files_pending_nodes").collect()).length)).toBe(256);

		const { result, cost } = await asOwner.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await ctx.runMutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: db.membershipId,
				target: { kind: "private", id: root.node._id },
				pendingUpdateId: root.proposal._id,
				reviewedRevision: root.proposal.revision,
			});
			return { result, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
		});
		console.info("discard_file_pending_update, 256 private nodes", cost);

		expect(result).toEqual({ _yay: null });
		const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state !== "discarded")).toEqual([]);
		expect_under_convex_limits(cost);
	}, 120_000);
});

describe("hard delete", () => {
	// The flush's inline part of a hard delete reads the node's hides and places and at most one
	// proposal (`.first()`); the saved node job then pages the proposals. So no hard-delete batch
	// counts proposals. This measures the inline part for 25 nodes with drafts of 5 users, then of 20
	// users: the ranges per node stay the same.
	const hard_delete_cost = async (userCount: number) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const seeded = await t.run(async (ctx) => {
			const a = await insert_saved_node(ctx, db, { parent: null, name: "a", kind: "folder" });
			const b = await insert_saved_node(ctx, db, { parent: null, name: "b", kind: "folder" });
			const files: Doc<"files_nodes">[] = [];
			for (let index = 0; index < 25; index++) {
				const file = await insert_saved_node(ctx, db, { parent: a, name: `note-${index}.md`, kind: "file" });
				await ctx.db.patch("files_nodes", file._id, { archiveOperationId: "archive-op" });
				files.push(file);
			}
			const userIds: Id<"users">[] = [];
			for (let index = 0; index < userCount; index++)
				userIds.push(await add_member(ctx, db, `clerk_hard_delete_${index}`));
			return { b, files, userIds };
		});
		// Each user drafts a move of every node into /b. One flush per user writes the places.
		for (const userId of seeded.userIds)
			await test_run_with_flush(t, async (ctx) => {
				for (const file of seeded.files)
					await ctx.db.insert("files_pending_updates", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId,
						target: { kind: "saved", id: file._id },
						revision: 1,
						size: 0,
						updatedAt: Date.now(),
						expiresAt: Date.now() + 60 * 60 * 1000,
						pendingMove: { destParent: { kind: "saved", id: seeded.b._id }, destName: file.name, fromPath: file.path },
					});
			});
		const places_of_files = () =>
			t.run(async (ctx) => {
				const places = [];
				for (const file of seeded.files)
					places.push(
						...(await ctx.db
							.query("files_pending_places")
							.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", file._id))
							.collect()),
					);
				return places;
			});
		expect(await places_of_files()).toHaveLength(25 * userCount);

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			for (const file of seeded.files) await ctx.db.delete("files_nodes", file._id);
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info(`hard delete, 25 archived nodes with drafts of ${userCount} users each`, cost);
		expect_under_convex_limits(cost);

		// The saved node jobs remove the places of the deleted nodes.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await places_of_files()).toEqual([]);
		return cost;
	};

	test("hard deletes 25 archived nodes with the same ranges for drafts of 5 or 20 users", async () => {
		const few = await hard_delete_cost(5);
		const many = await hard_delete_cost(20);
		expect(many.databaseQueries).toBe(few.databaseQueries);
	}, 120_000);
});

describe("metadata catalog", () => {
	// The most catalog work one node can cause: 896 committed metadata docs (128 frontmatter keys with
	// 3 values, 128 metadata keys with 2 values), each key 160 characters and each value 1,024 bytes,
	// the longest that still count. Every doc makes its own delta, so this is also the byte peak.
	test("measures create, full replacement, archive, restore and the compactor at maximum delta sizes", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const node = await t.run((ctx) => insert_saved_node(ctx, db, { parent: null, name: "max", kind: "folder" }));
		const docs = (round: number) =>
			(["frontmatter", "metadata"] as const).flatMap((namespace) =>
				Array.from({ length: 128 }, (_, key) => {
					const prefix = `${namespace}.r${round}k${key}-`;
					const fieldPath = prefix + "x".repeat(160 - prefix.length);
					const base = {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						sourceKind: "committed" as const,
						fileNodeId: node._id,
						path: node.path,
						treePath: node.treePath,
						fieldPath,
					};
					return [
						{ ...base, docKind: "field" as const, parentId: files_ROOT_ID },
						...Array.from({ length: namespace === "frontmatter" ? 3 : 2 }, (_, value) => {
							const head = `r${round}k${key}v${value}-`;
							return {
								...base,
								docKind: "value" as const,
								valueKind: "string" as const,
								stringValue: head + "v".repeat(1024 - head.length),
							};
						}),
					];
				}).flat(),
			);
		expect(docs(0)).toHaveLength(896);
		const { peaks, record } = budget_recorder();
		const measure = async (phase: string, write: (ctx: MutationCtx) => Promise<void>) =>
			await test_run_with_flush(t, async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				await write(ctx);
				await files_pending_overlay_db_flush(ctx);
				record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			});
		const all_docs = (ctx: MutationCtx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", node._id),
				)
				.collect();
		test_spy_handler(compact_metadata_catalog, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("catalog/compactor", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const compact = async () => {
			for (let run = 0; run < 100; run++) {
				vi.setSystemTime(Date.now() + 5001);
				const marker = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").first());
				if (!marker) return;
				await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker._id });
			}
			throw new Error("The catalog compactor did not drain");
		};
		const count = (table: "files_metadata_catalog" | "files_metadata_catalog_deltas") =>
			t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

		await measure("catalog/create", async (ctx) => {
			for (const doc of docs(0)) await ctx.db.insert("files_metadata_docs", doc);
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(1152);
		await compact();
		expect(await count("files_metadata_catalog")).toBe(1152);
		await measure("catalog/replace", async (ctx) => {
			for (const doc of await all_docs(ctx)) await ctx.db.delete("files_metadata_docs", doc._id);
			for (const doc of docs(1)) await ctx.db.insert("files_metadata_docs", doc);
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(2304);
		await compact();
		// Each archive or restore patch reads its doc first, like the scope helper's own query.
		await measure("catalog/archive", async (ctx) => {
			for (const doc of await all_docs(ctx))
				await ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId: "archive-op" });
		});
		await compact();
		expect(await count("files_metadata_catalog")).toBe(0);
		await measure("catalog/restore", async (ctx) => {
			for (const doc of await all_docs(ctx))
				await ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId: undefined });
		});
		await compact();
		expect(await count("files_metadata_catalog")).toBe(1152);
		console.info("metadata catalog peaks at maximum delta sizes", JSON.stringify(Object.fromEntries(peaks)));
		expect(peaks.get("catalog/compactor")?.measured.documentsRead).toBeGreaterThan(1000);
	}, 600_000);
});

describe("content save", () => {
	// A content save patches the file node, so the flush rewrites every share row of a shared file
	// that is a restricted root (see `share_100_times`).
	test("saves a shared file with 100 shares", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const file = await t.run(async (ctx) => {
			const file = await insert_saved_node(ctx, db, { parent: null, name: "shared.md", kind: "file" });
			await ctx.db.patch("files_nodes", file._id, { restrictedScopeNodeId: file._id, isRestrictedScopeRoot: true });
			return file;
		});
		await share_100_times(t, db, file._id);

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			// The node fields a content save patches in files_nodes_content.ts, without the new asset.
			await ctx.db.patch("files_nodes", file._id, {
				contentByteSize: 2048,
				updatedBy: db.userId,
				updatedAt: Date.now() + 1000,
			});
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info("content save, a shared file with 100 shares", cost);

		const rows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(rows).toHaveLength(100);
		expect(rows.every((row) => row.contentByteSize === 2048)).toBe(true);
		expect_under_convex_limits(cost);
	}, 120_000);

	// A rename of a folder changes the `treePath` of every node below it. A job that writes a shared
	// folder's new path (a restore, a scope job) does it through the flush, which rewrites every share
	// row of the folder.
	test("rewrites the paths of a shared folder with 100 shares after its parent's rename", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const { parent, shared } = await t.run(async (ctx) => {
			const parent = await insert_saved_node(ctx, db, { parent: null, name: "p", kind: "folder" });
			const shared = await insert_saved_node(ctx, db, { parent, name: "shared", kind: "folder" });
			await ctx.db.patch("files_nodes", shared._id, { restrictedScopeNodeId: shared._id, isRestrictedScopeRoot: true });
			return { parent, shared };
		});
		await share_100_times(t, db, shared._id);
		const renamed = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", parent._id, {
				name: "p2",
				sortName: files_sort_text_key("p2"),
				path: "/p2",
				treePath: "/p2/",
			});
			return (await ctx.db.get("files_nodes", parent._id))!;
		});

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			await files_nodes_db_rebuild_node(ctx, { node: (await ctx.db.get("files_nodes", shared._id))!, parent: renamed });
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info("path rewrite, a shared folder with 100 shares", cost);

		const rows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(rows).toHaveLength(100);
		expect(rows.every((row) => row.treePath === "/p2/shared/")).toBe(true);
		expect_under_convex_limits(cost);
	}, 120_000);
});
