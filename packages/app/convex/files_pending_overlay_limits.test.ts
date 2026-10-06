// Three big writers also flush the pending overlay: the interactive move, the bulk Accept and the
// private Discard. This file measures what one transaction of each flow costs, at its size cap. If a
// flow no longer fits the Convex limits, lower its cap to the measured value with a 25% margin.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.
// The tests seed hundreds of docs and are slow under a full-suite load, so each has a 120s timeout.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { commit_unit } from "./files_pending_update_runs.ts";
import {
	test_convex,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Db = Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
type Metrics = Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;

/**
 * The work done between two metric reads in one transaction.
 */
function transaction_cost(before: Metrics, after: Metrics) {
	return {
		databaseQueries: after.databaseQueries.used - before.databaseQueries.used,
		documentsRead: after.documentsRead.used - before.documentsRead.used,
		bytesRead: after.bytesRead.used - before.bytesRead.used,
		documentsWritten: after.documentsWritten.used - before.documentsWritten.used,
		bytesWritten: after.bytesWritten.used - before.bytesWritten.used,
		functionsScheduled: after.functionsScheduled.used - before.functionsScheduled.used,
	};
}

/**
 * Check one transaction against the Convex limits. `transactionLimits: true` already throws past
 * them, so these asserts show the numbers and keep the check if that option goes away.
 */
function expect_under_convex_limits(cost: ReturnType<typeof transaction_cost>) {
	expect(cost.databaseQueries, "databaseQueries").toBeLessThan(4096);
	expect(cost.documentsRead, "documentsRead").toBeLessThan(32_000);
	expect(cost.bytesRead, "bytesRead").toBeLessThan(16 * 1024 * 1024);
	expect(cost.documentsWritten, "documentsWritten").toBeLessThan(16_000);
	expect(cost.bytesWritten, "bytesWritten").toBeLessThan(16 * 1024 * 1024);
	expect(cost.functionsScheduled, "functionsScheduled").toBeLessThan(1000);
}

async function add_member(ctx: MutationCtx, db: Db, clerkUserId: string) {
	const userId = await ctx.db.insert("users", { clerkUserId });
	await ctx.db.insert("organizations_workspaces_users", {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		active: true,
		updatedAt: Date.now(),
	});
	await access_control_db_ensure_role_assignment(ctx, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		role: "member",
		now: Date.now(),
	});
	return userId;
}

async function insert_saved_node(
	ctx: MutationCtx,
	db: Db,
	args: { parent: Doc<"files_nodes"> | null; name: string; kind: "file" | "folder"; createdBy?: Id<"users"> },
) {
	const path = `${args.parent?.path ?? ""}/${args.name}`;
	const nodeId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		createdBy: args.createdBy ?? db.userId,
		updatedBy: args.createdBy ?? db.userId,
		parentId: args.parent?._id ?? files_ROOT_ID,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		kind: args.kind,
		path,
		treePath: args.kind === "folder" ? `${path}/` : path,
		pathDepth: path.split("/").length - 1,
	});
	return (await ctx.db.get("files_nodes", nodeId))!;
}

/**
 * Write committed frontmatter the way a Markdown save does: one field doc and one value doc per key.
 */
async function write_frontmatter(ctx: MutationCtx, fileNode: Doc<"files_nodes">, fieldCount: number) {
	await files_metadata_db_write_entries(ctx, {
		fileNode,
		entries: Array.from({ length: fieldCount }, (_, index) => ({ key: `field${index}`, value: `value ${index}` })),
	});
}

describe("move_nodes", () => {
	// MAX_MOVE_NODE_COUNT in files_nodes.ts. With the overlay flush, each moved item reads about 19-22
	// index ranges here: 186 items fit the 4,096 ranges and 187 throw. The cap keeps a 25% margin.
	// One item more than the cap must answer `move_too_large`, never a Convex limit error.
	const MAX_MOVE_NODE_COUNT = 139;

	test.each([
		{ itemCount: MAX_MOVE_NODE_COUNT, allowed: true },
		{ itemCount: MAX_MOVE_NODE_COUNT + 1, allowed: false },
	])(
		"moves $itemCount selected items while other users have drafts inside",
		async ({ itemCount, allowed }) => {
			const t = test_convex({ transactionLimits: true });
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

			// `/project` holds the selected items: folders with two files each, and files with one frontmatter
			// field each. The move job walks the files inside the folders.
			const seeded = await t.run(async (ctx) => {
				const project = await insert_saved_node(ctx, db, { parent: null, name: "project", kind: "folder" });
				const archive = await insert_saved_node(ctx, db, { parent: null, name: "archive", kind: "folder" });
				const items: Doc<"files_nodes">[] = [];
				for (let index = 0; index < itemCount; index++) {
					const kind = index % 12 === 0 ? "folder" : "file";
					const item = await insert_saved_node(ctx, db, {
						parent: project,
						name: kind === "folder" ? `folder-${index}` : `note-${index}.md`,
						kind,
					});
					items.push(item);
					if (kind === "file") await write_frontmatter(ctx, item, 1);
					else
						for (const name of ["a.md", "b.md"])
							await write_frontmatter(ctx, await insert_saved_node(ctx, db, { parent: item, name, kind: "file" }), 1);
				}
				const others = [
					await add_member(ctx, db, "clerk_move_other_1"),
					await add_member(ctx, db, "clerk_move_other_2"),
				];
				return { project, archive, items, others };
			});
			const files = seeded.items.filter((item) => item.kind === "file");
			const folders = seeded.items.filter((item) => item.kind === "folder");

			// Each other user drafts 10 moves, 10 renames and 10 deletes of moved items, and a private
			// folder with a file inside a moved folder.
			for (const [userIndex, userId] of seeded.others.entries()) {
				const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId };
				const mine = files.slice(userIndex * 30, userIndex * 30 + 30);
				for (const [index, file] of mine.entries()) {
					const target = { kind: "saved" as const, id: file._id };
					const drafted =
						index < 10
							? await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
									...scope,
									target,
									destParent: { kind: "saved", id: folders[1]!._id },
									destName: file.name,
								})
							: index < 20
								? await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
										...scope,
										target,
										destParent: { kind: "saved", id: seeded.project._id },
										destName: `renamed-${file.name}`,
									})
								: await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
										...scope,
										target,
									});
					if (drafted._nay) throw new Error(drafted._nay.message);
				}
				const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					...scope,
					path: `${folders[2 + userIndex]!.path}/private-${userIndex}/draft.md`,
					kind: "file",
				});
				if (created._nay) throw new Error(created._nay.message);
			}

			const { result, cost } = await asOwner.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runMutation(api.files_nodes.move_nodes, {
					membershipId: db.membershipId,
					itemIds: seeded.items.map((item) => item._id),
					targetParentId: seeded.archive._id,
				});
				return { result, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
			});
			console.info(`move_nodes, ${itemCount} items`, cost);

			if (allowed) expect(result).toEqual({ _yay: null });
			else expect(result._nay?.name).toBe("move_too_large");
			const moved = await t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.parentId === seeded.archive._id),
			);
			expect(moved).toHaveLength(allowed ? itemCount : 0);
			expect_under_convex_limits(cost);
		},
		120_000,
	);

	// A saved write refreshes every hide and place of each node it moves. A user may add one to a node
	// only while other users hold fewer than 32 (MAX_OTHER_USERS_DOCS_PER_SAVED_NODE in
	// server/files-pending-overlay.ts). This moves the most items, each with 32 docs of 16 other users.
	test("moves the most items while each has the most hides and places of other users", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const seeded = await t.run(async (ctx) => {
			const project = await insert_saved_node(ctx, db, { parent: null, name: "project", kind: "folder" });
			const archive = await insert_saved_node(ctx, db, { parent: null, name: "archive", kind: "folder" });
			const drafts = await insert_saved_node(ctx, db, { parent: null, name: "drafts", kind: "folder" });
			const items: Doc<"files_nodes">[] = [];
			for (let index = 0; index < MAX_MOVE_NODE_COUNT; index++)
				items.push(await insert_saved_node(ctx, db, { parent: project, name: `note-${index}.md`, kind: "file" }));
			const userIds: Id<"users">[] = [];
			for (let index = 0; index < 16; index++) userIds.push(await add_member(ctx, db, `clerk_crowd_${index}`));
			return { archive, drafts, items, userIds };
		});
		// The first user drafts a move of every item into /drafts: a hide and a place each. The other
		// users get copies of those docs, which is faster than 15 more flushes.
		await test_run_with_flush(t, async (ctx) => {
			for (const item of seeded.items)
				await ctx.db.insert("files_pending_updates", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: seeded.userIds[0]!,
					target: { kind: "saved", id: item._id },
					revision: 1,
					size: 0,
					updatedAt: Date.now(),
					expiresAt: Date.now() + 60 * 60 * 1000,
					pendingMove: {
						destParent: { kind: "saved", id: seeded.drafts._id },
						destName: item.name,
						fromPath: item.path,
					},
				});
		});
		await t.run(async (ctx) => {
			const hides = await ctx.db.query("files_pending_hides").collect();
			const places = await ctx.db.query("files_pending_places").collect();
			expect([hides.length, places.length]).toEqual([MAX_MOVE_NODE_COUNT, MAX_MOVE_NODE_COUNT]);
			for (const userId of seeded.userIds.slice(1)) {
				for (const { _id, _creationTime, ...hide } of hides)
					await ctx.db.insert("files_pending_hides", { ...hide, userId });
				for (const { _id, _creationTime, ...place } of places)
					await ctx.db.insert("files_pending_places", { ...place, userId });
			}
		});

		const { result, cost } = await asOwner.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await ctx.runMutation(api.files_nodes.move_nodes, {
				membershipId: db.membershipId,
				itemIds: seeded.items.map((item) => item._id),
				targetParentId: seeded.archive._id,
			});
			return { result, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
		});
		console.info(`move_nodes, ${MAX_MOVE_NODE_COUNT} items with 32 docs of other users each`, cost);

		expect(result).toEqual({ _yay: null });
		const hides = await t.run((ctx) => ctx.db.query("files_pending_hides").collect());
		expect(hides).toHaveLength(MAX_MOVE_NODE_COUNT * 16);
		expect(hides.every((hide) => hide.parentId === seeded.archive._id)).toBe(true);
		// The cap keeps a 25% margin under every Convex limit.
		expect(cost.databaseQueries, "databaseQueries").toBeLessThan(4096 * 0.75);
		expect(cost.documentsRead, "documentsRead").toBeLessThan(32_000 * 0.75);
		expect(cost.bytesRead, "bytesRead").toBeLessThan(16 * 1024 * 1024 * 0.75);
		expect(cost.documentsWritten, "documentsWritten").toBeLessThan(16_000 * 0.75);
		expect(cost.bytesWritten, "bytesWritten").toBeLessThan(16 * 1024 * 1024 * 0.75);
		expect(cost.functionsScheduled, "functionsScheduled").toBeLessThan(1000 * 0.75);
	}, 120_000);
});

describe("commit_unit", () => {
	test("accepts 100 moves of files with 20 frontmatter fields each", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

		const seeded = await t.run(async (ctx) => {
			const inbox = await insert_saved_node(ctx, db, { parent: null, name: "inbox", kind: "folder" });
			const done = await insert_saved_node(ctx, db, { parent: null, name: "done", kind: "folder" });
			const files: Doc<"files_nodes">[] = [];
			for (let index = 0; index < 100; index++) {
				const file = await insert_saved_node(ctx, db, { parent: inbox, name: `note-${index}.md`, kind: "file" });
				await write_frontmatter(ctx, file, 20);
				files.push(file);
			}
			return { done, files };
		});
		for (const file of seeded.files) {
			const drafted = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target: { kind: "saved", id: file._id },
				destParent: { kind: "saved", id: seeded.done._id },
				destName: file.name,
			});
			if (drafted._nay) throw new Error(drafted._nay.message);
		}
		// These moves do not depend on each other, so the run commits each one as its own unit. Linked
		// moves share one unit: 99 moves into one new private folder answer `move_too_large`, because
		// their 4,059 docs pass MAX_MOVE_DOCUMENT_COUNT (2,000).
		const proposals = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());

		// The review action calls `commit_unit` itself, so no test transaction can wrap it. convex-test
		// runs a function through its `_handler`. Wrap that to read the metrics inside each commit.
		const commits: Array<ReturnType<typeof transaction_cost>> = [];
		test_spy_handler(commit_unit, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			commits.push(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});

		const started = await asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: proposals.length,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId }),
		).toEqual({
			_yay: null,
		});

		// Drive the run like its scheduled jobs would: plan, then prepare and commit each unit.
		for (let pass = 0; ; pass++) {
			if (pass === 100) throw new Error("Review planning did not finish");
			await t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
			if ((await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))?.step !== "planning") break;
		}
		for (let pass = 0; ; pass++) {
			if (pass === 1000) throw new Error("Review did not finish");
			await t.mutation(internal.files_pending_update_runs.advance, { runId });
			const run = (await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))!;
			if (run.step === "finished") break;
			const unit = await t.run((ctx) =>
				ctx.db
					.query("files_pending_update_run_units")
					.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
					.first(),
			);
			if (unit)
				await t.action(internal.files_pending_update_runs.prepare_unit, {
					runId,
					fence: run.fence,
					unitId: unit._id,
					attemptFence: unit.attemptFence,
				});
		}
		// Without this, a spy that sees no commit would measure nothing and still pass.
		expect(commits.length).toBeGreaterThan(0);
		const biggest = { ...commits[0]! };
		for (const cost of commits)
			for (const key of Object.keys(biggest) as Array<keyof typeof biggest>)
				biggest[key] = Math.max(biggest[key], cost[key]);
		console.info("files_pending_update_runs accept, 100 moves", { commitUnitCount: commits.length, biggest });

		expect(
			(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.activity,
		).toMatchObject({ status: "succeeded", progress: { completed: 100 } });
		const moved = await t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).filter((node) => node.parentId === seeded.done._id),
		);
		expect(moved).toHaveLength(100);
		for (const cost of commits) expect_under_convex_limits(cost);
	}, 120_000);
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
