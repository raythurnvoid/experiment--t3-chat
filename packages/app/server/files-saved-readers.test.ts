import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "../convex/setup.test.ts";
import type { files_SavedStream } from "../shared/files.ts";
import { test_create_saved_placement_fixture } from "./files-saved-placement.test-fixtures.ts";
import { files_pending_overlay_list } from "./files-pending-overlay.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("saved-readers-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("saved tree sources keep the normal names until publication", async () => {
	const f = await test_create_saved_placement_fixture({ normalPaths: ["/normal.txt"] });
	const read = async () => {
		const view = await f.asUser.query(api.files_nodes.get_workspace_move_view, { membershipId: f.db.membershipId });
		if (!view?.cohortId || !view.view) throw new Error("Expected the fixture Move view");
		const pages = await Promise.all(
			([
				{ kind: "normal", generation: view.generation },
				{ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation },
			] as const).flatMap((savedStream) =>
				(["root", f.parentId] as const).flatMap((parentId) =>
					(["folder", "file"] as const).map((kind) =>
						f.asUser.query(api.files_nodes.list_tree_children, {
							membershipId: f.db.membershipId,
							parentId,
							kind,
							archived: false,
							restricted: false,
							savedStream,
							paginationOpts: { cursor: null, numItems: 20 },
						}),
					),
				),
			),
		);
		return pages.flatMap((page) => page.page).sort((a, b) => a.path.localeCompare(b.path));
	};
	expect(
		(await read()).map((node) => node.path),
		"both saved sources keep all normal names",
	).toEqual(["/normal.txt", "/old.txt", "/target"]);
	await f.publish();
	const after = await read();
	expect(after.map((node) => node.path)).toEqual(["/normal.txt", "/target", "/target/new.txt"]);
	expect(after.find((node) => node.path === "/target/new.txt")?._id).toBe(f.nodeId);
	expect(after.every((node) => !("moveCohortId" in node))).toBe(true);
});

test("metadata reads merge normal and selected facts before and after the switch", async () => {
	const f = await test_create_saved_placement_fixture({ normalPaths: ["/normal.txt", "/meta.txt"] });
	const nodeId = f.normalNodes.get("/meta.txt")!;
	for (const [id, metadataYaml] of [
		[f.normalNodes.get("/normal.txt")!, "normal: true"],
		[nodeId, "status: old"],
	] as const) {
		expect(
			await f.asUser.mutation(api.files_metadata.set_entries, {
				membershipId: f.db.membershipId,
				fileNodeId: id,
				metadataYaml,
			}),
		).toEqual({ _yay: null });
	}
	await f.stageNode(nodeId);
	// Pause the reader fixture while owned-file facts sit in both views. The wrapper moves the
	// metadata catalog rows with the docs.
	await test_run_with_flush(f.t, async (ctx) => {
		const docs = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
				q
					.eq("organizationId", f.db.organizationId)
					.eq("workspaceId", f.db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.collect();
		for (const doc of docs) {
			const { _id, _creationTime: _time, ...fields } = doc;
			await ctx.db.patch("files_metadata_docs", _id, { moveView: { cohortId: f.cohortId, view: "before" } });
			await ctx.db.insert("files_metadata_docs", {
				...fields,
				moveView: { cohortId: f.cohortId, view: "after" },
				...(doc.docKind === "value" ? { stringValue: "new" } : { sortDisplayValue: "new" }),
			});
		}
	});
	// The browser reads the normal stream and the visible Move view's stream of each door, and merges
	// them. The clock goes back after the compactor, so Move leases see no time pass.
	const read_streams = async (read: (savedStream: files_SavedStream) => Promise<string[]>) => {
		const now = Date.now();
		await test_compact_metadata_catalog(f.t);
		vi.setSystemTime(now);
		const view = await f.asUser.query(api.files_nodes.get_workspace_move_view, { membershipId: f.db.membershipId });
		if (!view) throw new Error("Expected the workspace view");
		const streams: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
		if (view.cohortId && view.view)
			streams.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
		return [...new Set((await Promise.all(streams.map(read))).flat())].sort();
	};
	const paginationOpts = { numItems: 50, cursor: null };
	const fields = () =>
		read_streams(async (savedStream) =>
			(
				await f.asUser.query(api.files_metadata.list_folder_fields, {
					membershipId: f.db.membershipId,
					savedStream,
					parentId: "root",
					prefix: "",
					paginationOpts,
				})
			).page,
		);
	const values = () =>
		read_streams(async (savedStream) =>
			(
				await f.asUser.query(api.files_metadata.list_search_values, {
					membershipId: f.db.membershipId,
					savedStream,
					fieldPath: "metadata.status",
					prefix: "",
					paginationOpts,
				})
			).page,
		);
	const keys = () =>
		read_streams(async (savedStream) =>
			(
				await f.asUser.query(api.files_metadata.list_search_fields, {
					membershipId: f.db.membershipId,
					savedStream,
					prefix: "",
					paginationOpts,
				})
			).page.map((field) => field.fieldPath),
		);
	const byPath = () =>
		f.t.query(internal.files_metadata.get_by_path, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			path: "/meta.txt",
		});
	expect((await byPath())?.values, "Bash metadata keeps selected before docs").toEqual([
		{ fieldPath: "metadata.status", valueKind: "string", stringValue: "old" },
	]);
	expect(await fields(), "selected metadata remains in the folder fields").toEqual([
		"metadata.normal",
		"metadata.status",
	]);
	expect(await values()).toEqual(["old"]);
	expect(await keys()).toEqual(["metadata.normal", "metadata.status"]);
	expect(
		(
			await f.asUser.query(api.files_metadata.list_node_fields, {
				membershipId: f.db.membershipId,
				target: { kind: "saved", id: nodeId },
				cursor: null,
			})
		)?.fields,
	).toEqual(["metadata.status"]);
	await f.publish();
	expect((await byPath())?.values, "Bash metadata selects after docs at publication").toEqual([
		{ fieldPath: "metadata.status", valueKind: "string", stringValue: "new" },
	]);
	await test_run_with_flush(f.t, async (ctx) => {
		const doc = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
				q
					.eq("organizationId", f.db.organizationId)
					.eq("workspaceId", f.db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId)
					.eq("moveView.cohortId", f.cohortId)
					.eq("moveView.view", "after"),
			)
			.first();
		if (!doc) throw new Error("Expected an after metadata doc");
		await ctx.db.patch("files_metadata_docs", doc._id, { moveView: undefined });
	});
	expect((await byPath())?.fields, "Bash metadata merges a partly cleaned selected view").toEqual(["metadata.status"]);
	expect(await fields()).toEqual(["metadata.normal", "metadata.status"]);
	expect(await values(), "after metadata wins at the shared switch").toEqual(["new"]);
});

test("metadata pages keep every moved-in match during an unrelated Move", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	async function folder(path: string) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	}
	const sourceId = await folder("/source");
	const targetId = await folder("/target");
	const movingId = await folder("/moving");
	const destinationId = await folder("/destination");
	const expected: string[] = [];
	for (const name of ["a", "b", "c"]) {
		const nodeId = await folder(`/source/${name}`);
		expect(
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: "note: match",
			}),
		).toEqual({ _yay: null });
		expected.push(`${nodeId}:/target/source/${name}`);
	}
	expect(
		(
			await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target: { kind: "saved", id: sourceId },
				destParent: { kind: "saved", id: targetId },
				destName: "source",
			})
		)._nay,
	).toBeUndefined();
	async function matches(folderPath: string, op: "exists" | "eq") {
		let cursor: string | null = null;
		const found: string[] = [];
		for (let page = 0; page < 20; page++) {
			const result: Awaited<ReturnType<typeof files_pending_overlay_list>> = await files_pending_overlay_list(
				{ runQuery: t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					overlayUserId: db.userId,
					folderPath,
					mode: "metadata",
					plan:
						op === "exists" ? { op, fieldPath: "metadata.note" } : { op, fieldPath: "metadata.note", value: "match" },
					order: "asc",
					numItems: 1,
					cursor,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			found.push(...result._yay.items.map((entry) => `${entry.target.id}:${entry.path}`));
			if (result._yay.isDone) return found;
			cursor = result._yay.continueCursor;
		}
		throw new Error("The small metadata listing did not finish");
	}
	for (const op of ["exists", "eq"] as const)
		for (const path of ["/target", "/target/source"])
			expect(await matches(path, op), "normal metadata pages include all draft paths").toEqual(expected);
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sourceIds: [movingId],
		expectedSourceCount: 1,
		targetParentId: destinationId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	for (let pass = 0; pass < 1000; pass++) {
		const slot = await t.run((ctx) =>
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique(),
		);
		if (slot?.cohortId) {
			const cohort = await t.run((ctx) => ctx.db.get("files_move_cohorts", slot.cohortId!));
			if (!cohort) throw new Error("Expected the public Move group");
			expect(cohort.errorCode).toBeNull();
			if (cohort.workPhase === "publish") break;
			await t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
		} else {
			const jobs = await t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
					.collect(),
			);
			const job = jobs.find((job) => job.blockedByCohortId === undefined);
			if (job)
				await t.mutation(internal.files_pending_overlay.run_job, {
					kind: job.kind,
					key: job.key,
					nextAttemptAt: job.nextAttemptAt,
				});
			else await t.mutation(internal.files_transfer.advance, { runId });
		}
		if (pass === 999) throw new Error("The unrelated Move did not reach publication");
	}
	for (const op of ["exists", "eq"] as const)
		for (const path of ["/target", "/target/source"])
			expect(await matches(path, op), "metadata continuation keeps every moved-in target during a cohort").toEqual(
				expected,
			);
}, 120_000);

test.each([false, true])(
	"history access follows the published scope before physical cleanup (restricted before: %s)",
	async (restrictedBefore) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: await ctx.db.insert("users", { clerkUserId: "saved-history-owner" }),
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const closed = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "/closed",
		});
		const open = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "/open",
		});
		if (closed._nay || open._nay) throw new Error("Expected native source and destination folders");
		expect(
			(
				await asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: db.membershipId,
					nodeId: closed._yay.nodeId,
				})
			)._nay,
		).toBeUndefined();
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: restrictedBefore ? "/closed/file.txt" : "/open/file.txt",
			textContent: "Saved history.\n",
		});
		const f = { t, db, asUser, nodeId, parentId: closed._yay.nodeId };
		const memberId = await f.t.run((ctx) => ctx.db.insert("users", { clerkUserId: "saved-history-reader" }));
		expect(
			(
				await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userIdToAdd: memberId,
				})
			)._nay,
		).toBeUndefined();
		const membership = await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.db.workspaceId).eq("userId", memberId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected the invited membership");
		const asMember = f.t.withIdentity({ issuer: "https://clerk.test", external_id: memberId });
		const ownerHistory = await f.asUser.query(api.files_nodes.get_file_snapshots_list, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			showArchived: false,
		});
		const snapshot = ownerHistory.snapshots[0];
		if (!snapshot) throw new Error("Expected native Save history");
		const list = () =>
			asMember.query(api.files_nodes.get_file_snapshots_list, {
				membershipId: membership._id,
				nodeId: f.nodeId,
				showArchived: false,
			});
		const get = () =>
			asMember.query(api.files_nodes.get_file_snapshot, {
				membershipId: membership._id,
				nodeId: f.nodeId,
				snapshotId: snapshot._id,
			});
		const sign = () =>
			f.t.query(internal.files_nodes.get_data_for_create_file_snapshot_content_url, {
				userId: memberId,
				membershipId: membership._id,
				nodeId: f.nodeId,
				snapshotId: snapshot._id,
			});
		expect((await list()).snapshots.length > 0).toBe(!restrictedBefore);
		expect((await get()) !== null).toBe(!restrictedBefore);
		expect((await sign()) !== null).toBe(!restrictedBefore);
		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "move",
			sourceIds: [nodeId],
			expectedSourceCount: 1,
			targetParentId: restrictedBefore ? open._yay.nodeId : closed._yay.nodeId,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		for (let pass = 0; pass < 1000; pass++) {
			const slot = await t.run((ctx) =>
				ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
					.unique(),
			);
			if (slot?.cohortId) {
				const cohort = await t.run((ctx) => ctx.db.get("files_move_cohorts", slot.cohortId!));
				if (!cohort) throw new Error("Expected the native Move group");
				expect(cohort.errorCode).toBeNull();
				if (cohort.publishedAt !== null) break;
				await t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
			} else {
				const jobs = await t.run((ctx) =>
					ctx.db
						.query("files_pending_overlay_jobs")
						.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
						.collect(),
				);
				const job = jobs.find((job) => job.blockedByCohortId === undefined);
				if (job)
					await t.mutation(internal.files_pending_overlay.run_job, {
						kind: job.kind,
						key: job.key,
						nextAttemptAt: job.nextAttemptAt,
					});
				else await t.mutation(internal.files_transfer.advance, { runId });
			}
			if (pass === 999) throw new Error("The native Move did not publish");
		}
		expect((await list()).snapshots.length > 0, "history uses the published permission before cleanup").toBe(
			restrictedBefore,
		);
		expect((await get()) !== null).toBe(restrictedBefore);
		expect((await sign()) !== null).toBe(restrictedBefore);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.restrictedScopeNodeId).toBe(
			restrictedBefore ? f.parentId : null,
		);
	},
	120_000,
);
