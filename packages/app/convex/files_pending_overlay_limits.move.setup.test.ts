// The paged Move budget fixture shared by the files_pending_overlay_limits.move test files.
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	advance as advance_transfer,
	accept_input as accept_transfer_input,
	append_input as append_transfer_input,
} from "./files_transfer.ts";
import { advance as advance_subtree } from "./files_subtree_ops.ts";
import { compact_metadata_catalog, run_job as run_overlay_job } from "./files_pending_overlay.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { files_metadata_preflight_frontmatter } from "../shared/files-metadata.ts";
import {
	type Metadata,
	add_member,
	budget_recorder,
	finish_scheduled,
	insert_saved_node,
	measure_cohort,
	transaction_cost,
} from "./files_pending_overlay_limits.setup.test.ts";

// MAX_OTHER_USERS_DOCS_PER_SAVED_NODE in files-pending-overlay.ts is 32, one hide and one place
// per user. So at most 16 users can draft on one saved node.
export const MAX_DRAFT_OWNERS = 16;

// Moves a heavy file with `keys` frontmatter and metadata keys (128 is the maximum) and `lines`
// lines of text while `owners` users draft a move of it. Also moves a folder with restricted
// folders and a file with a link.
export const measure_paged_move = async (args: { owners: number; keys: number; lines: number; dense?: boolean }) => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const dates = Array.from({ length: args.keys }, (_, index) =>
		new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
	);
	const frontmatter = [
		"---",
		...dates.map((date, index) => {
			const key = args.dense ? `field${index}-`.padEnd(148, "k") : `field${index}`;
			const value = args.dense ? `distinct-${index}-`.padEnd(1024, "x") : `distinct-${index}`;
			return `${key}: ["${value}", "${date}"]`;
		}),
		"---",
		"",
	].join("\n");
	const body = "A large saved file keeps its text chunks beside both metadata sources.\n".repeat(args.lines);
	const textContent = frontmatter + body;
	const metadataYaml = dates.map((date, index) => `key${index}: "${date}"`).join("\n");
	if (args.dense) {
		expect(new TextEncoder().encode(textContent).byteLength).toBeLessThanOrEqual(900_000);
		expect(new TextEncoder().encode(metadataYaml).byteLength).toBeLessThanOrEqual(16 * 1024);
		expect(files_metadata_preflight_frontmatter(textContent)._yay).toMatchObject({ fieldCount: 128, indexDocumentCount: 512 });
	}
	const heavyId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/project/heavy.md",
		textContent,
	});
	expect(
		await asOwner.mutation(api.files_metadata.set_entries, {
			membershipId: db.membershipId,
			fileNodeId: heavyId,
			metadataYaml,
		}),
	).toEqual({ _yay: null });
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	console.info("Move budget fixture: committed text and maximum metadata ready");

	const seeded = await t.run(async (ctx) => {
		const heavy = (await ctx.db.get("files_nodes", heavyId))!;
		const project = (await ctx.db.get("files_nodes", heavy.parentId as Id<"files_nodes">))!;
		const target = await insert_saved_node(ctx, db, { parent: null, name: "target", kind: "folder" });
		const drafts = await insert_saved_node(ctx, db, { parent: null, name: "drafts", kind: "folder" });
		const shared = await insert_saved_node(ctx, db, { parent: project, name: "shared", kind: "folder" });
		const light: Doc<"files_nodes">[] = [];
		const links: Doc<"files_nodes">[] = [];
		const users: Id<"users">[] = [];
		for (let index = 0; index < 51; index++) users.push(await add_member(ctx, db, `clerk_move_budget_${index}`));
		const metadata = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", heavyId),
			)
			.collect();
		return { heavy, project, target, drafts, shared, light, links, users, metadata };
	});
	expect(seeded.metadata.filter((doc) => doc.fieldPath.startsWith("frontmatter."))).toHaveLength(args.keys * 4);
	expect(seeded.metadata.filter((doc) => doc.fieldPath.startsWith("metadata."))).toHaveLength(args.keys * 3);
	if (args.dense) expect(seeded.metadata.every((doc) => doc.fieldPath.length <= 160), "Dense metadata keys fit the catalog").toBe(true);
	// Owner steps page these docs 8 at a time (PAGE_SIZE in files_move_owner_work.ts). Use full pages.
	expect(seeded.metadata.length, "the metadata fills more than one owner page").toBeGreaterThan(8);
	let extraLinkId: Id<"files_nodes"> | null = null;
	for (const [parentId, count] of [
		[seeded.project._id, 99],
		[files_ROOT_ID, 402],
	] as const) {
		for (let offset = 0; offset < count; offset += 50) {
			vi.setSystemTime(Date.now() + 60_000);
			const uploaded = await asOwner.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId,
				onConflict: "skip",
				items: Array.from({ length: Math.min(50, count - offset) }, (_, index) => ({
					relativePath: `link-${offset + index}.bin`,
					size: 1,
					contentType: "application/octet-stream",
				})),
			});
			if (uploaded._nay) throw new Error(uploaded._nay.message);
			expect(uploaded._yay.skipped).toHaveLength(0);
			const created = uploaded._yay.created;
			for (const item of created) {
				expect(await fetch(item.url, { method: "PUT", body: "x" })).toHaveProperty("status", 200);
				expect(
					await t.mutation(internal.r2.process_uploaded_asset_event, {
						assetId: item.assetId,
						r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
						size: 1,
						eventId: `move-budget-${item.assetId}`,
					}),
				).toEqual({ _yay: null });
			}
			const nodes = await t.run((ctx) =>
				Promise.all(created.map(async (item) => (await ctx.db.get("files_nodes", item.nodeId))!)),
			);
			for (const node of nodes) {
				if (seeded.links.length < 500) seeded.links.push(node);
				else extraLinkId = node._id;
				if (parentId === seeded.project._id) seeded.light.push(node);
			}
		}
	}
	if (!extraLinkId) throw new Error("Expected one extra link target");
	await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
	console.info("Move budget fixture: native upload targets ready");

	// Advance only the clock: setup should not run expiry jobs between fixture writes.
	const refill_sharing = () => vi.setSystemTime(Date.now() + 3_000);
	refill_sharing();
	expect(
		await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: heavyId }),
	).toEqual({ _yay: null });
	for (const userId of seeded.users.slice(0, 50)) {
		refill_sharing();
		expect(
			await asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: db.membershipId,
				nodeId: heavyId,
				principal: { kind: "user", userId },
				level: "manage",
			}),
		).toEqual({ _yay: null });
	}
	refill_sharing();
	expect(
		(
			await asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: db.membershipId,
				nodeId: heavyId,
				principal: { kind: "user", userId: seeded.users[50]! },
				level: "manage",
			})
		)._nay?.message,
	).toContain("at most 50");
	for (let index = 0; index < 9; index++) {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: `${seeded.shared.path}/restricted-${index}`,
		});
		if (created._nay) throw new Error(created._nay.message);
		refill_sharing();
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: db.membershipId,
				nodeId: created._yay.nodeId,
			}),
		).toEqual({ _yay: null });
	}
	// Seed the link load. Keep the native 500th success and 501st refusal.
	await t.run(async (ctx) => {
		for (const [index, node] of seeded.links.slice(0, 499).entries())
			await ctx.db.insert("files_share_links", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId: node._id,
				token: index.toString(16).padStart(64, "0"),
				restrictedScopeNodeId: node.restrictedScopeNodeId,
				createdBy: db.userId,
				createdAt: Date.now(),
			});
	});
	refill_sharing();
	expect(
		await asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: db.membershipId,
			nodeId: seeded.links[499]!._id,
			enabled: true,
		}),
	).toEqual({ _yay: null });
	console.info("Move budget fixture: public links ready", 500);
	refill_sharing();
	expect(
		(
			await asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: db.membershipId,
				nodeId: extraLinkId,
				enabled: true,
			})
		)._nay?.message,
	).toContain("at most 500");
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	for (const userId of seeded.users.slice(0, args.owners)) {
		expect(
			await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				target: { kind: "saved", id: heavyId },
				destParent: { kind: "saved", id: seeded.drafts._id },
				destName: seeded.heavy.name,
			}),
		).toMatchObject({
			_yay: { fromPath: seeded.heavy.path, destPath: `${seeded.drafts.path}/${seeded.heavy.name}` },
		});
	}
	if (args.owners === MAX_DRAFT_OWNERS)
		await expect(
			t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: seeded.users[MAX_DRAFT_OWNERS]!,
				target: { kind: "saved", id: heavyId },
				destParent: { kind: "saved", id: seeded.drafts._id },
				destName: seeded.heavy.name,
			}),
			"the cap refuses one more owner draft",
		).rejects.toThrow("Too many people have pending changes");
	console.info("Move budget fixture: shares, links and owner drafts ready");
	// Restrict updated the metadata flags after the initial fixture was saved.
	const metadataBeforeMove = await t.run(async (ctx) => {
		expect(
			await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", heavyId))
				.collect(),
		).toHaveLength(args.owners);
		expect(
			await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", heavyId))
				.collect(),
		).toHaveLength(args.owners);
		expect(
			await ctx.db
				.query("files_share_rows")
				.withIndex("by_node", (q) => q.eq("nodeId", heavyId))
				.collect(),
		).toHaveLength(50);
		expect(await ctx.db.query("files_share_links").collect()).toHaveLength(500);
		return args.dense
			? await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", heavyId),
					)
					.collect() as Metadata[]
			: [];
	});
	const savedTextBeforeMove = args.dense
		? await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
			path: seeded.heavy.path, includePending: false,
		})
		: null;
	if (args.dense)
		expect(savedTextBeforeMove?.content, "Save puts a blank line after the rich-text frontmatter").toBe(frontmatter + "\n" + body);

	const { peaks, record, check } = budget_recorder();
	const metadataPages = measure_cohort(record, metadataBeforeMove);
	// The metadata catalog's compactor runs in its own transactions while the Move goes on.
	test_spy_handler(compact_metadata_catalog, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		record("catalog/compactor", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	for (const [phase, registered] of [
		["accept", accept_transfer_input],
		["append", append_transfer_input],
	] as const) {
		test_spy_handler(registered, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
	}
	// The native 140-root test covers selection size. These roots keep the maximum per-node cost.
	const sources = [heavyId, seeded.shared._id, seeded.light[0]!._id];
	const started = await asOwner.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: "move-budget",
		kind: "move",
		expectedSourceCount: sources.length,
		sourceIds: sources.slice(0, 1),
		targetParentId: seeded.target._id,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId } = started._yay;
	test_spy_handler(advance_transfer, async (handler, ctx, args) => {
		const run = (await ctx.db.get("files_transfer_runs", runId))!;
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
		record(`transfer/${run.step}`, cost);
		return result;
	});
	test_spy_handler(advance_subtree, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		record("subtree", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	test_spy_handler(run_overlay_job, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		record("overlay", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	expect(
		await asOwner.mutation(api.files_transfer.append_input, {
			membershipId: db.membershipId,
			runId,
			offset: 1,
			sourceIds: sources.slice(1),
		}),
	).toEqual({ _yay: null });
	// Move completion can come before its delayed catalog work.
	await finish_scheduled(t, async () => {
		if (args.dense && metadataPages.length) {
			const page = metadataPages[0]!;
			const cohort = await t.run((ctx) => ctx.db.get("files_move_cohorts", page.cohortId));
			expect(cohort).not.toBeNull();
			expect(page.rowIds.length, "Dense metadata uses 64 rows when the byte bound allows it").toBe(64);
		}
		if ((await asOwner.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt === undefined)
			return false;
		return await t.run(async (ctx) => !(await ctx.db
			.query("files_metadata_catalog_compactors")
			.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
			.first()));
	});
	console.info(
		"paged Move phase peaks, with the metadata catalog",
		JSON.stringify({ args, phases: Object.fromEntries(peaks) }),
	);
	expect(await asOwner.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
		activity: { status: "succeeded", progress: { completed: 3, failed: 0, canceled: 0 } },
	});
	// A small root can publish inside the Transfer call, whose whole cost is measured above.
	const cohorts = await t.run((ctx) => ctx.db.query("files_move_cohorts")
		.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId)).collect());
	expect(cohorts, "every saved Move root reaches cohort publication").toHaveLength(sources.length);
	for (const cohort of cohorts)
		expect(cohort).toMatchObject({ phase: "complete", visibleView: "after", publishedAt: expect.any(Number), errorCode: null });
	expect(peaks.get("catalog/compactor")?.calls, "the Move's catalog deltas reach the compactor").toBeGreaterThan(0);
	expect(
		peaks.get("catalog/compactor")?.measured.documentsWritten,
		"the compactor applies the Move's catalog deltas",
	).toBeGreaterThan(0);
	expect(peaks.get("cohort/descendants")?.calls).toBeGreaterThan(0);
	expect(peaks.get("cohort/finish_owners")?.calls).toBeGreaterThan(0);
	if (args.dense) {
		// Check outside the worker too: a worker can catch a failed budget assertion.
		check("Dense metadata Move stays below the budget after the flush");
		const metadata = await t.run((ctx) => ctx.db.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", heavyId))
			.collect()) as Metadata[];
		const metadata_fields = (rows: Doc<"files_metadata_docs">[]) => rows.map((row) => Object.fromEntries(Object.entries(row)
			.filter(([key]) => !["_id", "_creationTime", "moveView", "path", "treePath", "parentId"].includes(key))))
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		expect(metadata, "Dense metadata keeps all 896 saved docs").toHaveLength(896);
		expect(metadata_fields(metadata), "Dense Move keeps the metadata captured after Restrict")
			.toEqual(metadata_fields(metadataBeforeMove));
		expect(metadata.every((row) => row.moveView === undefined && row.path === "/target/heavy.md" && row.treePath === row.path)).toBe(true);
		expect(metadata.filter((row) => row.docKind === "field").every((row) => row.parentId === seeded.target._id)).toBe(true);
		expect((await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
			path: "/target/heavy.md", includePending: false,
		}))?.content, "Dense metadata Move keeps its saved text").toBe(savedTextBeforeMove?.content);
	}
};
