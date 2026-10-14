// The advance and resolve_conflicts tests, split from files_transfer.test.ts so the two files can run at the
// same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import {
	test_save_file_pending_update,
	test_move_nodes,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { r2_create_asset_key, r2_server_side_copy } from "./r2_client.ts";
import {
	r2Objects,
	mock_transfer_storage,
	create_folder_fixture,
	start_transfer,
	start_agent_transfer,
	start_copy,
	finish_discovery,
	finish_folder_copy,
	finish_copy_worker,
	finish_copy_with_workers,
	get_node,
	add_member,
} from "./files_transfer.setup.test.ts";

beforeEach(mock_transfer_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("advance", () => {
	test.each([
		["Free", "saved"],
		["full", "saved"],
		["Free", "proposal"],
		["full", "proposal"],
	] as const)("refuses a stored copy on %s before allocating %s content", async (state, publication) => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const created = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "source.bin",
			contentType: "application/octet-stream",
			size: 8,
		});
		if (created._nay) throw new Error(created._nay.message);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", created._yay.assetId, {
				r2Key: r2_create_asset_key({ ...db, assetId: created._yay.assetId }),
			});
			if (state === "Free") await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
			else {
				const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
				await ctx.db.patch("quotas", quotaId, { usedCount: 10, maxCount: 10 });
			}
		});
		let runId: Id<"files_transfer_runs">;
		if (publication === "saved") runId = await start_copy(fixture, [created._yay.nodeId]);
		else {
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "stored-copy-admission",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "stored-copy-admission",
				kind: "copy",
				sources: [{ kind: "saved", id: created._yay.nodeId }],
				targetParent: { kind: "saved", id: fixture.folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			runId = started._yay.runId;
		}
		const before = await t.run(async (ctx) => ({
			assets: await ctx.db.query("files_r2_assets").collect(),
			nodes: await ctx.db.query("files_nodes").collect(),
			privateNodes: await ctx.db.query("files_pending_nodes").collect(),
			quotas: await ctx.db.query("quotas").collect(),
		}));
		await finish_copy_with_workers(fixture, runId);
		expect(
			await t.run(async (ctx) => ({
				assets: await ctx.db.query("files_r2_assets").collect(),
				nodes: await ctx.db.query("files_nodes").collect(),
				privateNodes: await ctx.db.query("files_pending_nodes").collect(),
				quotas: await ctx.db.query("quotas").collect(),
			})),
		).toEqual(before);
		expect(
			(
				await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_order", (q) => q.eq("runId", runId))
						.first(),
				)
			)?.errorMessage,
		).toBe(
			state === "Free"
				? "This workspace's plan does not include file uploads"
				: "This workspace has reached its storage limit",
		);
	});

	test.each(["saved", "private", "replacement", "review"] as const)(
		"a stored %s copy charges two cents and counts its 20 MiB plus one byte once",
		async (publication) => {
			const fixture = await create_folder_fixture([]);
			const { t, db, asUser } = fixture;
			const size = 20 * 1024 * 1024 + 1;
			const created = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename: "source.bin",
				contentType: "application/octet-stream",
				size,
			});
			if (created._nay) throw new Error(created._nay.message);
			const key = r2_create_asset_key({ ...db, assetId: created._yay.assetId });
			r2Objects.set(key, new Uint8Array(size));
			await t.run((ctx) =>
				ctx.db.patch("files_r2_assets", created._yay.assetId, { r2Key: key, unfinalizedExpiresAt: undefined }),
			);
			if (publication === "replacement") {
				const destination = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: fixture.folders.get("/target")!,
					filename: "source.bin",
					contentType: "application/octet-stream",
					size: 8,
				});
				if (destination._nay) throw new Error(destination._nay.message);
				const destinationKey = r2_create_asset_key({ ...db, assetId: destination._yay.assetId });
				r2Objects.set(destinationKey, new Uint8Array(8));
				await t.run((ctx) =>
					ctx.db.patch("files_r2_assets", destination._yay.assetId, {
						r2Key: destinationKey,
						unfinalizedExpiresAt: undefined,
					}),
				);
			}
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = r2Objects.get(args.sourceKey)!;
				r2Objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "stored-copy" };
			});
			const before = await t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			let runId: Id<"files_transfer_runs">;
			if (publication === "saved") runId = await start_copy(fixture, [created._yay.nodeId]);
			else {
				const thread = await asUser.mutation(api.ai_chat.thread_create, {
					membershipId: db.membershipId,
					clientGeneratedId: "stored-copy-charge",
					lastMessageAt: Date.now(),
				});
				if (thread._nay) throw new Error(thread._nay.message);
				const started = await start_agent_transfer(t, {
					membershipId: db.membershipId,
					sourceWorkspace: "current",
					destinationWorkspace: "current",
					threadId: thread._yay.threadId,
					requestId: "stored-copy-charge",
					kind: "copy",
					sources: [{ kind: "saved", id: created._yay.nodeId }],
					targetParent: { kind: "saved", id: fixture.folders.get("/target")! },
					targetPath: "/target",
					targetName: null,
					missingParentNames: [],
					conflictPolicy: { file: "replace", folder: "merge" },
				});
				if (started._nay) throw new Error(started._nay.message);
				runId = started._yay.runId;
			}
			expect((await finish_copy_with_workers(fixture, runId)).activity.status).toBe("succeeded");
			if (publication !== "saved") {
				expect(await t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(before);
				const proposal = await t.run((ctx) => ctx.db.query("files_pending_updates").first());
				if (!proposal) throw new Error("Expected the prepared copy");
				if (publication === "review") {
					// Paid plans may use credit below zero and pay the extra amount later.
					await t.run((ctx) =>
						ctx.db.patch("billing_usage_snapshots", before!._id, { meter: { ...before!.meter!, balance: 1 } }),
					);
					const started = await asUser.mutation(api.files_pending_update_runs.start, {
						membershipId: db.membershipId,
						requestId: "stored-copy-paid-overage",
						kind: "accept",
						expectedItemCount: 1,
						items: [
							{ pendingUpdateId: proposal!._id, reviewedRevision: proposal!.revision, selectedContentStateId: null },
						],
					});
					if (started._nay) throw new Error(started._nay.message);
					const reviewRunId = started._yay.runId;
					expect(
						await asUser.mutation(api.files_pending_update_runs.seal, {
							membershipId: db.membershipId,
							runId: reviewRunId,
						}),
					).toEqual({ _yay: null });
					// Accept saves the copy in a Move group, so use the driver that also runs its steps.
					await test_finish_pending_update_run(asUser, reviewRunId);
					expect(
						(
							await asUser.query(api.files_pending_update_runs.get, {
								membershipId: db.membershipId,
								runId: reviewRunId,
							})
						)?.activity.status,
					).toBe("succeeded");
				} else {
					const saved = await test_save_file_pending_update(asUser, {
						membershipId: db.membershipId,
						target: proposal.target,
						pendingUpdateId: proposal._id,
						reviewedRevision: proposal.revision,
					});
					if (saved._nay) throw new Error(saved._nay.message);
				}
			}
			const after = await t.run(async (ctx) => ({
				quota: await ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("quotaName", "stored_file_bytes"),
					)
					.first(),
				usage: await ctx.db.query("billing_usage_snapshots").first(),
				item: await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.first(),
			}));
			expect(after.quota?.usedCount).toBe(size);
			expect(after.usage?.meter?.balance).toBe(publication === "review" ? -1 : before!.meter!.balance - 2);
			await t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: after.item!._id,
				attempt: after.item!.attempt,
			});
			expect(await t.run((ctx) => ctx.db.get("quotas", after.quota!._id))).toEqual(after.quota);
			expect(await t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(after.usage);
		},
	);

	test("finishes canceled when the only preparing leaf is discarded", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/report.txt",
			textContent: "Source report\n",
		});
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "discard-only-copy-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "discard-only-copy",
			kind: "copy",
			sources: [{ kind: "saved", id: sourceId }],
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.unique(),
		);
		if (!item?.preparation || !item.workId) throw new Error("Expected a preparing file worker");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", item.preparation!.pendingUpdateId));
		if (!proposal) throw new Error("Expected its proposal");
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
					membershipId: db.membershipId,
					target: proposal.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "canceled" },
		});
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "canceled",
			progress: { total: 1, completed: 0, failed: 0, blocked: 0, canceled: 1 },
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item._id))).toMatchObject({
			state: "canceled",
			cancelReason: "proposal_discard",
			outputTarget: null,
		});
		expect(await get_node(fixture, "/target/report.txt")).toBeNull();
		expect((await get_node(fixture, "/source/report.txt"))?._id).toBe(sourceId);
	});

	test("a later lock on a copied parent refuses the next child", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		expect(copiedParent).not.toBeNull();
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedParent!._id,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		const finished = await finish_folder_copy(fixture, runId);
		expect(finished.activity.status).toBe("partial");
		expect(await get_node(fixture, "/target/source/child.txt")).toBeNull();
		const failedChild = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(failedChild.some((item) => item.sourcePath === "/source/child.txt" && item.state === "failed")).toBe(true);
	});

	test("copies children into a locked copy of a read-only folder", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/nested"]);
		const { t, db, asUser, folders } = fixture;
		for (const name of ["a.txt", "b.txt"]) {
			await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: `/source/${name}`,
				textContent: `${name}\n`,
			});
		}
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source")!,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);

		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: 4, completed: 4, failed: 0 },
		});
		expect(await get_node(fixture, "/target/source")).toMatchObject({ writePolicy: { mode: "read_only" } });
		for (const path of ["/target/source/nested", "/target/source/a.txt", "/target/source/b.txt"]) {
			expect(await get_node(fixture, path)).not.toBeNull();
		}
	});

	test("still copies children after the produced parent's new-item default changes", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedParent!._id,
					newChildWritePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		// The default change moves the folder's revision but leaves it writable.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: 2, completed: 2, failed: 0 },
		});
		expect(await get_node(fixture, "/target/source/child.txt")).not.toBeNull();
	});

	test("still copies children after the produced parent is locked then unlocked", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		for (const writePolicy of [{ mode: "read_only" as const }, null]) {
			expect(
				(
					await asUser.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: db.membershipId,
						nodeId: copiedParent!._id,
						writePolicy,
					})
				)._nay,
			).toBeUndefined();
		}

		// The lock and unlock moved the revision twice, but the folder is writable again.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: 2, completed: 2, failed: 0 },
		});
		expect(await get_node(fixture, "/target/source/child.txt")).not.toBeNull();
	});

	test("fails children when the produced parent is locked with a different policy", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source")!,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedParent!._id,
					writePolicy: { mode: "writer", writers: [{ kind: "user", userId: member.userId }] },
				})
			)._nay,
		).toBeUndefined();

		// The copy kept the run's lock, but someone replaced it with a different one.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "partial",
			progress: { total: 2, completed: 1, failed: 1 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.find((entry) => entry.sourcePath === "/source/child.txt")).toMatchObject({
			state: "failed",
			errorMessage: "This item is read-only.",
		});
		expect(await get_node(fixture, "/target/source/child.txt")).toBeNull();
	});

	test.each([
		{ publication: "saved", destination: "fresh" },
		{ publication: "proposal", destination: "fresh" },
		{ publication: "saved", destination: "keep_both" },
		{ publication: "proposal", destination: "keep_both" },
		{ publication: "proposal", destination: "merge" },
	] as const)("checks a finite descendant copy ($publication, $destination)", async ({ publication, destination }) => {
		const sourcePaths = ["/source", "/source/out", "/source/empty"];
		if (destination !== "fresh") sourcePaths.push("/source/out/source", "/source/out/source/child");
		const fixture = await create_folder_fixture(sourcePaths);
		const { t, db, asUser, folders } = fixture;
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "descendant-copy-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started =
			publication === "saved"
				? await start_transfer(asUser, {
						membershipId: db.membershipId,
						requestId: "descendant-copy",
						kind: "copy",
						sourceIds: [folders.get("/source")!],
						targetParentId: folders.get("/source/out")!,
					})
				: await start_agent_transfer(t, {
						membershipId: db.membershipId,
						sourceWorkspace: "current",
						destinationWorkspace: "current",
						threadId: thread._yay.threadId,
						requestId: "descendant-copy",
						kind: "copy",
						sources: [{ kind: "saved", id: folders.get("/source")! }],
						targetParent: { kind: "saved", id: folders.get("/source/out")! },
						targetPath: "/source/out",
						targetName: null,
						missingParentNames: [],
						conflictPolicy: { file: "replace", folder: destination === "keep_both" ? "ask" : "merge" },
					});
		expect(started._nay).toBeUndefined();
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const checked = await finish_discovery(fixture, runId);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		if (destination !== "fresh" && (publication === "saved" || destination === "keep_both")) {
			expect(checked.activity.status).toBe("awaiting_input");
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_parentItem", (q) => q.eq("runId", runId).eq("parentItemId", null))
					.unique(),
			);
			if (!item?.conflictTarget) throw new Error("Expected a destination conflict");
			const resolved = await asUser.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: db.membershipId,
				runId,
				revision: checked.revision,
				choices: [
					{
						itemId: item._id,
						choice: destination,
						reviewedTarget: item.conflictTarget,
						reviewedVersion: item.conflictVersion,
					},
				],
				applyToRemaining: { file: null, folder: null },
			});
			expect(resolved._nay).toBeUndefined();
		}
		const finished = await finish_folder_copy(fixture, runId);
		if (destination === "merge") {
			expect(finished.activity).toMatchObject({ status: "failed", progress: { completed: 0 } });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
			return;
		}
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: sourcePaths.length, completed: sourcePaths.length, failed: 0 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => item.sourcePath).sort()).toEqual(sourcePaths.toSorted());
		const outputRoot = destination === "fresh" ? "/source/out/source" : "/source/out/source-copy-1";
		expect(items.map((item) => item.outputPath).sort()).toEqual(
			sourcePaths.map((path) => outputRoot + path.slice("/source".length)).sort(),
		);
		expect(items.every((item) => item.outputTarget?.kind === (publication === "saved" ? "saved" : "private"))).toBe(
			true,
		);
		if (publication === "proposal") expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		for (const path of sourcePaths) expect((await get_node(fixture, path))?._id).toBe(folders.get(path));
	});

	test.each([false, true])("refuses a merge into a copy source in any root order (reversed: %s)", async (reversed) => {
		const fixture = await create_folder_fixture(["/source", "/source/out", "/source/out/source", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const fileId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/other/report.txt",
			textContent: "Report\n",
		});
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		// The saved text file above leaves its own published draft, so compare against that state.
		const draftsBefore = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "merge-source-order-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const sources = [
			{ kind: "saved" as const, id: fileId },
			{ kind: "saved" as const, id: folders.get("/source")! },
		];
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "merge-source-order",
			kind: "copy",
			sources: reversed ? sources.toReversed() : sources,
			targetParent: { kind: "saved", id: folders.get("/source/out")! },
			targetPath: "/source/out",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			progress: { completed: 0 },
			errorMessage: "A copy cannot replace or merge into its sources",
		});
		// The refusal lands while the names are resolved, so the run never reaches a worker and the
		// order of the selected roots cannot change the outcome.
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => item.sourcePath).toSorted()).toEqual([
			"/other/report.txt",
			"/source",
			"/source/out",
			"/source/out/source",
		]);
		expect(items.every((item) => item.attempt === 0 && item.workId === null && item.outputTarget === null)).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(draftsBefore);
	});

	test("copies nested empty folders and folder metadata with fresh IDs", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/empty", "/source/nested/deep"]);
		const { db, asUser, folders } = fixture;
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: folders.get("/source")!,
					metadataYaml: "owner: Ray",
				})
			)._nay,
		).toBeUndefined();
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect(await finish_discovery(fixture, runId)).toMatchObject({
			step: "apply",
			activity: { status: "running", progress: { total: 4, completed: 0 } },
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 4, completed: 4, failed: 0 } },
		});
		for (const path of ["/source", "/source/empty", "/source/nested", "/source/nested/deep"]) {
			const original = await get_node(fixture, path);
			const copied = await get_node(fixture, `/target${path}`);
			expect(copied?.kind).toBe("folder");
			expect(copied?._id).not.toBe(original?._id);
		}
		const copiedRoot = await get_node(fixture, "/target/source");
		expect(
			await asUser.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: copiedRoot!._id,
			}),
		).toEqual([{ key: "owner", value: "Ray" }]);
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toEqual([]);
	});

	test("shows the first file failure and keeps completed folders", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const fileIds: Id<"files_nodes">[] = [];
		for (const filename of ["first.bin", "second.bin"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get("/source")!,
				filename,
				contentType: "application/octet-stream",
				size: 8,
			});
			if (file._nay) throw new Error(file._nay.message);
			fileIds.push(file._yay.nodeId);
			if (filename === "second.bin") {
				await t.run((ctx) =>
					ctx.db.patch("files_r2_assets", file._yay.assetId, {
						r2Key: r2_create_asset_key({ ...db, assetId: file._yay.assetId }),
					}),
				);
			}
		}
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const copiedFolder = await get_node(fixture, "/target/source");
		expect(copiedFolder?.kind).toBe("folder");
		for (const [index, sourceId] of fileIds.entries()) {
			if (index === 1) {
				await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" }));
			}
			await t.mutation(internal.files_transfer.advance, { runId });
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) => q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", sourceId))
					.unique(),
			);
			if (!item?.workId) throw new Error("Missing queued copy worker");
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item._id))).toMatchObject({
				state: "failed",
				errorMessage:
					index === 0
						? "The source file is still saving. Try again."
						: "This workspace's plan does not include file uploads",
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: item.workId,
				context: { itemId: item._id, attempt: item.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: {
				status: "partial",
				progress: { total: 3, completed: 1, failed: 2 },
				errorMessage: "The source file is still saving. Try again.",
			},
		});
		const activities = (
			await asUser.query(api.activities_feed.list_page, {
				membershipId: db.membershipId,
				section: "history",
				paginationOpts: { cursor: null, numItems: 50 },
			})
		).page;
		expect(activities.find((activity) => activity.source.id === runId)).toMatchObject({
			status: "partial",
			errorMessage: "The source file is still saving. Try again.",
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(copiedFolder!._id);
		expect(await get_node(fixture, "/target/source/first.bin")).toBeNull();
		expect(await get_node(fixture, "/target/source/second.bin")).toBeNull();
	});

	test("keeps at most two file copies in flight", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		for (const filename of ["first.bin", "second.bin", "third.bin"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get("/source")!,
				filename,
				contentType: "application/octet-stream",
				size: 8,
			});
			if (file._nay) throw new Error(file._nay.message);
		}
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);

		const read_items = async () =>
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
		// Copy shares two worker slots with review preparation, so more advances must not queue a
		// third file.
		for (let step = 0; step < 10; step += 1) await t.mutation(internal.files_transfer.advance, { runId });
		const queued = await read_items();
		expect(queued.filter((item) => item.workId !== null)).toHaveLength(2);
		expect(queued.filter((item) => item.state === "pending" && item.workId === null)).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({ inFlight: 2 });

		// One finished worker frees one slot, so the waiting file starts and the cap still holds.
		const waiting = queued.find((item) => item.state === "pending" && item.workId === null)!;
		const running = queued.find((item) => item.workId !== null)!;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: running._id, attempt: running.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: running.workId!,
			context: { itemId: running._id, attempt: running.attempt },
			result: { kind: "success", returnValue: null },
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		const after = await read_items();
		expect(after.find((item) => item._id === waiting._id)?.workId).not.toBeNull();
		expect(after.filter((item) => item.workId !== null)).toHaveLength(2);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({ inFlight: 2 });
	});

	test("discovers more than one page before creating any output", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			step: "discover",
			activity: { status: "running", progress: { discovered: 51, total: null, completed: 0 } },
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.progress,
		).toMatchObject({ discovered: 56, total: null });
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 56, completed: 56 } },
		});
		for (const path of paths) expect(await get_node(fixture, `/target${path}`)).not.toBeNull();
	});

	test("copies a child added between discovery pages only when it sorts after the cursor", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.progress,
		).toMatchObject({ discovered: 51, total: null });

		// Discovery pages the children by name, so the first page stopped after "folder-49". A name added
		// after that point is still ahead of the cursor and joins the copy. A name added before it is
		// already behind the cursor and the second page never sees it. Either way the copy stays whole:
		// a child is copied completely or not at all, and neither name is copied twice.
		for (const path of ["late-after-cursor", "early-before-cursor"]) {
			expect(
				(
					await asUser.mutation(api.files_nodes.create_folder_node, {
						membershipId: db.membershipId,
						parentId: folders.get("/source")!,
						path,
					})
				)._nay,
			).toBeUndefined();
		}

		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.progress,
		).toMatchObject({ discovered: 57, total: null });
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 57, completed: 57 } },
		});
		expect(await get_node(fixture, "/target/source/late-after-cursor")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/early-before-cursor")).toBeNull();
		for (const path of paths) expect(await get_node(fixture, `/target${path}`)).not.toBeNull();
	});

	test("asks for a choice when a discovered child moves out between discovery pages", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, db, asUser, folders } = fixture;
		// Copy and Move of one user share one lane, so a teammate moves the child.
		const member = await add_member(fixture);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(
				await test_move_nodes(t, member.asUser, {
						membershipId: member.membershipId,
						itemIds: [folders.get("/source/folder-00")!],
						targetParentId: folders.get("/target")!,
					})
			)._nay,
		).toBeUndefined();

		// The second page finishes the root, then discovery reaches the moved child and finds it at a new
		// path. The run stops and asks the user instead of copying from where the child used to be.
		await t.mutation(internal.files_transfer.advance, { runId });
		await t.mutation(internal.files_transfer.advance, { runId });
		const view = await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId });
		expect(view).toMatchObject({
			step: "discover",
			activity: { status: "awaiting_input", progress: { discovered: 56, total: null, completed: 0, blocked: 1 } },
			conflicts: [{ kind: "source_changed", sourceName: null }],
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
	});

	test("refuses an unreadable descendant before copying its readable parent", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/hidden-name"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		expect(
			(
				await asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source/hidden-name")!,
				})
			)._nay,
		).toBeUndefined();
		const started = await start_transfer(member.asUser, {
			membershipId: member.membershipId,
			requestId: "hidden-child",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const view = await member.asUser.query(api.files_transfer_queries.get, {
			membershipId: member.membershipId,
			runId: started._yay.runId,
		});
		expect(view).toMatchObject({
			activity: { status: "failed", progress: { completed: 0 }, errorMessage: "Permission denied" },
		});
		expect(JSON.stringify(view)).not.toContain("hidden-name");
		expect(await get_node(fixture, "/target/source")).toBeNull();
	});

	// A member's running copy must stop when they are removed and invited again, because the invite
	// makes a new membership doc and the run belongs to the old one. The control keeps the same
	// member and the same copy, so only the re-invite can change the result.
	test.each([
		{ label: "keeps copying for a member who stayed in the workspace", reinvited: false },
		{ label: "stops copying for a member who was removed and invited again", reinvited: true },
	])("$label", async ({ reinvited }) => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, folders } = fixture;
		const member = await add_member(fixture);
		const started = await start_transfer(member.asUser, {
			membershipId: member.membershipId,
			requestId: "re-invited",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;

		if (reinvited) {
			await t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: member.userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				const membership = await ctx.db.get("organizations_workspaces_users", membershipId);
				if (!membership) throw new Error("Missing membership");
				expect(await organizations_membership_lifetimes_db_ensure(ctx, membership)).toBe(2);
			});
		}

		const read_activity = async () =>
			await t.run((ctx) =>
				ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", runId))
					.unique(),
			);
		for (let step = 0; step < 40; step += 1) {
			const activity = await read_activity();
			if (activity && !activities_is_active(activity.status)) break;
			await t.mutation(internal.files_transfer.advance, { runId });
		}

		if (reinvited) {
			expect(await read_activity()).toMatchObject({
				status: "failed",
				errorMessage: "Permission denied",
				progress: { completed: 0, canceled: 1 },
			});
			expect(await get_node(fixture, "/target/source")).toBeNull();
			return;
		}

		expect(await read_activity()).toMatchObject({ status: "succeeded", errorMessage: null });
		expect(await get_node(fixture, "/target/source/child")).not.toBeNull();
	});

	test("does not copy descendants added after discovery finishes", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/first"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
		expect(
			(
				await asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: db.membershipId,
					parentId: folders.get("/source")!,
					path: "later",
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 2, completed: 2 } },
		});
		expect(await get_node(fixture, "/target/source/first")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/later")).toBeNull();
	});

	test("gives a run waiting for a choice a much later deadline than a copying run", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child", "/target/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const read_deadline = async () =>
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))!.activity;

		const copying = await read_deadline();
		expect(copying.status).toBe("running");
		// A copy must not sit idle for long, so its deadline is half an hour.
		expect(copying.deadlineAt - Date.now()).toBe(30 * 60 * 1000);

		for (let step = 0; step < 50; step += 1) {
			if ((await read_deadline()).status === "awaiting_input") break;
			await t.mutation(internal.files_transfer.advance, { runId });
		}
		// Waiting for a person is different work, so the question gets a whole day of its own.
		const waiting = await read_deadline();
		expect(waiting.status).toBe("awaiting_input");
		expect(waiting.deadlineAt - Date.now()).toBe(24 * 60 * 60 * 1000);
	});

	test("keeps the job status and the counters on the Activity alone at every transition", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser } = fixture;
		// The copy of "asks.txt" meets an occupant in /target and asks; the answer is Skip. Its sibling
		// copies for real, so the run passes through a question and a worker before it finishes.
		const sourceIds: Id<"files_nodes">[] = [];
		for (const path of ["/source/asks.txt", "/source/copies.txt", "/target/asks.txt"]) {
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path,
				textContent: `Report for ${path}\n`,
			});
			if (path.startsWith("/source/")) sourceIds.push(nodeId);
		}
		const started = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "activity-transitions",
			kind: "copy",
			expectedSourceCount: sourceIds.length,
			sourceIds,
			targetParentId: fixture.folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});

		// The Activity owns the job status and the counters. The run doc must never grow its own copy,
		// and the counters must always match a fresh count of the items, so nothing can drift apart.
		const activityOwnedFields = ["status", "progress", "completed", "skipped", "failed", "canceled", "blocked"];
		const statusesSeen = new Set<string>();
		const read_both = async () => {
			const view = await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId });
			if (!view) throw new Error("Missing run");
			const run = await t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			const count = (state: Doc<"files_transfer_items">["state"]) =>
				items.filter((item) => item.state === state).length;

			statusesSeen.add(view.activity.status);
			expect(Object.keys(run!).filter((field) => activityOwnedFields.includes(field))).toEqual([]);
			expect(view.activity.progress).toMatchObject({
				discovered: items.length,
				completed: count("completed"),
				skipped: count("skipped"),
				failed: count("failed"),
				canceled: count("canceled"),
				blocked: count("conflict"),
			});
			return { view, items };
		};

		let current = await read_both();
		for (let step = 0; step < 50 && current.view.activity.status !== "awaiting_input"; step += 1) {
			await t.mutation(internal.files_transfer.advance, { runId });
			current = await read_both();
		}
		expect(current.view.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: current.view.revision,
					choices: [{ itemId: current.view.conflicts[0]!.itemId, choice: "skip" as const }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();

		current = await read_both();
		for (let step = 0; step < 50 && activities_is_active(current.view.activity.status); step += 1) {
			const queued = current.items.find((item) => item.state === "copying" && item.workId !== null);
			if (queued) await finish_copy_worker(fixture, queued);
			else await t.mutation(internal.files_transfer.advance, { runId });
			current = await read_both();
		}

		// The run really passed through all four states, so the checks above are not one repeated state.
		expect([...statusesSeen].toSorted()).toEqual(["awaiting_input", "queued", "running", "succeeded"]);
		expect(current.view.activity.progress).toMatchObject({ total: 2, completed: 1, skipped: 1, failed: 0 });
	});
});

describe("resolve_conflicts", () => {
	test.each([
		{ firstWorker: "first", outsideCollision: false, occupiedOriginal: false },
		{ firstWorker: "second", outsideCollision: false, occupiedOriginal: false },
		{ firstWorker: "second", outsideCollision: true, occupiedOriginal: false },
		{ firstWorker: "first", outsideCollision: true, occupiedOriginal: true },
	] as const)(
		"keeps file claims when the $firstWorker worker finishes first (outside collision: $outsideCollision, occupied original: $occupiedOriginal)",
		async ({ firstWorker, outsideCollision, occupiedOriginal }) => {
			const fixture = await create_folder_fixture(["/a", "/b"]);
			const { t, db, asUser } = fixture;
			const sourceIds: Id<"files_nodes">[] = [];
			for (const folder of ["a", "b"]) {
				sourceIds.push(
					await test_create_saved_text_file(t, {
						membershipId: db.membershipId,
						path: `/${folder}/report.txt`,
						textContent: `Report ${folder}: café 😀\n`,
					}),
				);
			}
			const originalId = occupiedOriginal
				? await test_create_saved_text_file(t, {
						membershipId: db.membershipId,
						path: "/target/report.txt",
						textContent: "Original report: résumé\n",
					})
				: null;
			const runId = await start_copy(fixture, sourceIds);
			const waiting = await finish_discovery(fixture, runId);
			expect(waiting.activity.status).toBe("awaiting_input");
			expect(waiting.conflicts).toHaveLength(occupiedOriginal ? 2 : 1);
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting.revision,
						choices: waiting.conflicts.map((conflict) => ({ itemId: conflict.itemId, choice: "keep_both" as const })),
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
			await finish_discovery(fixture, runId);
			const planned = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(planned.map((item) => item.plannedPath)).toEqual(
				occupiedOriginal
					? ["/target/report-copy-1.txt", "/target/report-copy-2.txt"]
					: ["/target/report.txt", "/target/report-copy-1.txt"],
			);
			// Another write may occupy a planned name before either file worker publishes.
			const outsideId = outsideCollision
				? await test_create_saved_text_file(t, {
						membershipId: db.membershipId,
						path: "/target/report-copy-1.txt",
						textContent: "Outside report: résumé\n",
					})
				: null;
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			const queued = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(queued.every((item) => item.state === "copying" && item.workId)).toBe(true);
			for (const item of firstWorker === "first" ? queued : queued.toReversed()) {
				await finish_copy_worker(fixture, item);
			}
			const finished = await finish_folder_copy(fixture, runId);
			expect(finished.activity).toMatchObject({
				status: "succeeded",
				progress: { completed: 2, total: 2, failed: 0, blocked: 0 },
			});
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			const outputPaths = occupiedOriginal
				? ["/target/report-copy-3.txt", "/target/report-copy-2.txt"]
				: ["/target/report.txt", `/target/report-copy-${outsideCollision ? 2 : 1}.txt`];
			expect(items.map((item) => item.outputPath)).toEqual(outputPaths);
			for (const [index, path] of outputPaths.entries()) {
				const copied = await get_node(fixture, path);
				expect(items[index]).toMatchObject({
					source: { kind: "saved", id: sourceIds[index] },
					outputTarget: { kind: "saved", id: copied!._id },
				});
				expect(sourceIds).not.toContain(copied!._id);
				const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", copied!.assetId!));
				const bytes = r2Objects.get(asset!.r2Key!);
				expect(bytes).toBeDefined();
				expect(new Uint8Array(await new Response(bytes).arrayBuffer())).toEqual(
					new TextEncoder().encode(`Report ${index === 0 ? "a" : "b"}: café 😀\n`),
				);
			}
			for (const outsideFile of [
				{ id: originalId, path: "/target/report.txt", text: "Original report: résumé\n" },
				{ id: outsideId, path: "/target/report-copy-1.txt", text: "Outside report: résumé\n" },
			]) {
				if (!outsideFile.id) continue;
				const outside = await get_node(fixture, outsideFile.path);
				expect(outside?._id).toBe(outsideFile.id);
				const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", outside!.assetId!));
				const bytes = r2Objects.get(asset!.r2Key!);
				expect(bytes).toBeDefined();
				expect(new Uint8Array(await new Response(bytes).arrayBuffer())).toEqual(
					new TextEncoder().encode(outsideFile.text),
				);
			}
		},
	);

	test.each(["saved", "proposal"] as const)("refuses duplicate file Replace before %s output", async (publication) => {
		const fixture = await create_folder_fixture(["/a", "/b"]);
		const { t, db, asUser, folders } = fixture;
		const sourceIds: Id<"files_nodes">[] = [];
		for (const folder of ["a", "b"]) {
			sourceIds.push(
				await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path: `/${folder}/report.txt`,
					textContent: `Report ${folder}\n`,
				}),
			);
		}
		const targetId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/target/report.txt",
			textContent: "Target report\n",
		});
		const before = await t.run((ctx) => ctx.db.get("files_nodes", targetId));
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "duplicate-file-replace-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started =
			publication === "saved"
				? await start_transfer(asUser, {
						membershipId: db.membershipId,
						requestId: "duplicate-file-replace",
						kind: "copy",
						sourceIds,
						targetParentId: folders.get("/target")!,
					})
				: await start_agent_transfer(t, {
						membershipId: db.membershipId,
						sourceWorkspace: "current",
						destinationWorkspace: "current",
						threadId: thread._yay.threadId,
						requestId: "duplicate-file-replace",
						kind: "copy",
						sources: sourceIds.map((id) => ({ kind: "saved" as const, id })),
						targetParent: { kind: "saved", id: folders.get("/target")! },
						targetPath: "/target",
						targetName: null,
						missingParentNames: [],
						conflictPolicy: { file: "replace", folder: "merge" },
					});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		if (publication === "saved") {
			const waiting = await finish_discovery(fixture, runId);
			expect(waiting.conflicts).toHaveLength(2);
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting.revision,
						choices: items.map((item) => ({
							itemId: item._id,
							choice: "replace" as const,
							reviewedTarget: item.conflictTarget!,
							reviewedVersion: item.conflictVersion,
						})),
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
		}
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			progress: { completed: 0 },
			errorMessage: "Several sources use the same destination",
		});
		expect(await t.run((ctx) => ctx.db.get("files_nodes", targetId))).toEqual(before);
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.every((item) => item.attempt === 0 && item.outputTarget === null)).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test.each([false, true])("file -n keeps the first argument (reversed: %s)", async (reversed) => {
		const fixture = await create_folder_fixture(["/a", "/b"]);
		const { t, db, asUser, folders } = fixture;
		const sourceIds: Id<"files_nodes">[] = [];
		for (const folder of ["a", "b"]) {
			sourceIds.push(
				await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path: `/${folder}/report.txt`,
					textContent: `Report ${folder}: café 😀\n`,
				}),
			);
		}
		if (reversed) sourceIds.reverse();
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "duplicate-file-skip-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "duplicate-file-skip",
			kind: "copy",
			sources: sourceIds.map((id) => ({ kind: "saved" as const, id })),
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "skip", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!item) throw new Error("Expected the first file");
		await finish_copy_worker(fixture, item);
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, skipped: 1, total: 2, failed: 0 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => item.source.id)).toEqual(sourceIds);
		expect(items[0]).toMatchObject({ state: "completed", outputPath: "/target/report.txt" });
		expect(items[1]).toMatchObject({ state: "skipped", attempt: 0, outputTarget: null, preparation: null });
		const output = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			overlayUserId: db.userId,
			path: "/target/report.txt",
			includePending: true,
		});
		expect(output?.target).toEqual(items[0]!.outputTarget);
		expect(new TextEncoder().encode(output?.content)).toEqual(
			new TextEncoder().encode(`Report ${reversed ? "b" : "a"}: café 😀\n`),
		);
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", output!.pendingUpdateId!));
		// These sources have no local lock. The copy still records that empty rule.
		expect(proposal?.copiedFrom).toEqual({
			target: { kind: "saved", id: sourceIds[0] },
			path: `/${reversed ? "b" : "a"}/report.txt`,
			sourceWritePolicy: null,
		});
		expect(await get_node(fixture, "/target/report.txt")).toBeNull();
	});

	test.each([false, true])("folder -Rn keeps the first duplicate branch (occupied: %s)", async (occupied) => {
		const fixture = await create_folder_fixture([
			"/a/report",
			"/a/report/first",
			"/b/report",
			"/b/report/second",
			...(occupied ? ["/target/report", "/target/report/keep"] : []),
		]);
		const { t, db, asUser, folders } = fixture;
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "duplicate-folder-skip-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "duplicate-folder-skip",
			kind: "copy",
			sources: [folders.get("/a/report")!, folders.get("/b/report")!].map((id) => ({ kind: "saved" as const, id })),
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "skip", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 2, skipped: 2, total: 4, failed: 0 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.filter((item) => item.sourcePath.startsWith("/a/")).every((item) => item.state === "completed")).toBe(
			true,
		);
		expect(
			items
				.filter((item) => item.sourcePath.startsWith("/b/"))
				.every((item) => item.state === "skipped" && item.attempt === 0 && item.outputTarget === null),
		).toBe(true);
		const parent = items.find((item) => item.source.id === folders.get("/a/report"));
		if (occupied) {
			expect(parent?.outputTarget).toEqual({ kind: "saved", id: folders.get("/target/report") });
			expect((await get_node(fixture, "/target/report/keep"))?._id).toBe(folders.get("/target/report/keep"));
		} else {
			expect(parent?.outputTarget?.kind).toBe("private");
		}
		expect(await get_node(fixture, "/target/report/second")).toBeNull();
	});

	// Only a Bash copy merges folders. A paste offers no Merge, so these claims are all proposals.
	test.each([{ extraRoots: 0 }, { extraRoots: 50 }] as const)(
		"refuses duplicate claims on an occupied folder before output ($extraRoots extra roots)",
		async ({ extraRoots }) => {
			const otherPaths = Array.from({ length: extraRoots }, (_, index) => `/other-${index}`);
			const fixture = await create_folder_fixture([
				"/a/report",
				"/a/report/first",
				"/b/report",
				"/b/report/second",
				"/target/report",
				...otherPaths,
			]);
			const { t, db, asUser, folders } = fixture;
			const sources = ["/a/report", ...otherPaths, "/b/report"].map((path) => folders.get(path)!);
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "duplicate-claim-thread",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "duplicate-claim",
				kind: "copy",
				sources: sources.map((id) => ({ kind: "saved" as const, id })),
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			const finished = await finish_folder_copy(fixture, runId);
			expect(finished.activity).toMatchObject({ status: "failed", progress: { completed: 0 } });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		},
	);

	test("keeps the normalized README extension in copy names", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const fileIds: Id<"files_nodes">[] = [];
		for (const path of ["/source", "/target"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get(path)!,
				filename: "README.md",
				contentType: "text/markdown",
				size: 0,
			});
			if (file._nay) throw new Error(file._nay.message);
			fileIds.push(file._yay.nodeId);
		}
		// Keep a legacy source spelling to test the new destination name.
		await t.run((ctx) => ctx.db.patch("files_nodes", fileIds[0]!, { name: "readme", path: "/source/readme" }));
		const runId = await start_copy(fixture, [fileIds[0]!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", waiting.conflicts[0]!.itemId))).toMatchObject({
			plannedPath: "/target/readme-copy-1.md",
		});
	});

	test.each([
		// The rename rules turn ".env" into "untitled.env" first, so the copy name has no leading dot
		// left to keep. The extension is still read from the right place.
		{ label: "dotfile", sourceName: ".env", plannedPath: "/target/untitled-copy-1.env", legacy: true },
		{ label: "extensionless", sourceName: "notes", plannedPath: "/target/notes-copy-1" },
		{ label: "compound extension", sourceName: "backup.tar.gz", plannedPath: "/target/backup-copy-1.tar.gz" },
		{
			label: "early-dot",
			sourceName: `x.${"n".repeat(250)}.md`,
			plannedPath: `/target/x.${"n".repeat(243)}-copy-1.md`,
		},
		{
			label: "early-dot at counter 10",
			sourceName: `x.${"n".repeat(243)}.md`,
			plannedPath: `/target/x.${"n".repeat(242)}-copy-10.md`,
			takenNames: Array.from({ length: 9 }, (_entry, index) => `x-copy-${index + 1}.${"n".repeat(243)}.md`),
		},
		// Accents are removed before Copy adds its counter.
		{
			label: "long multi-byte",
			sourceName: `${"é".repeat(200)}.md`,
			plannedPath: `/target/${"e".repeat(200)}-copy-1.md`,
			legacy: true,
		},
	])("builds a legal Keep-both name for a $label source", async (nameCase) => {
		const { label, sourceName, plannedPath } = nameCase;
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const fileIds: Id<"files_nodes">[] = [];
		for (const path of ["/source", "/target"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get(path)!,
				filename: sourceName,
				contentType: "text/markdown",
				size: 0,
			});
			if (file._nay) throw new Error(file._nay.message);
			const uploaded = (await t.run((ctx) => ctx.db.get("files_nodes", file._yay.nodeId)))!;
			// Only legacy spellings need a direct fixture write.
			if (nameCase.legacy) {
				await t.run((ctx) =>
					ctx.db.patch("files_nodes", file._yay.nodeId, { name: sourceName, path: `${path}/${sourceName}` }),
				);
			} else {
				expect(uploaded, `Upload keeps the ${label} name`).toMatchObject({
					name: sourceName,
					path: `${path}/${sourceName}`,
				});
			}
			fileIds.push(file._yay.nodeId);
		}
		for (const filename of nameCase.takenNames ?? []) {
			expect(
				(
					await asUser.mutation(api.files_nodes.create_upload_node, {
						membershipId: db.membershipId,
						parentId: folders.get("/target")!,
						filename,
						contentType: "text/markdown",
						size: 0,
						onConflict: "fail",
					})
				)._nay,
			).toBeUndefined();
		}
		const runId = await start_copy(fixture, [fileIds[0]!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		const resumed = await finish_discovery(fixture, runId);
		expect(
			await t.run((ctx) => ctx.db.get("files_transfer_items", waiting.conflicts[0]!.itemId)),
			`Copy plans a valid ${label} Keep-both name`,
		).toMatchObject({
			plannedPath,
		});
		expect(resumed.activity.status).toBe("running");
	});

	test("refuses a copy when every counter up to the attempt limit is taken", async () => {
		const taken = Array.from({ length: 100 }, (_entry, index) => `/target/dup-copy-${index + 1}`);
		const fixture = await create_folder_fixture(["/dup", "/target/dup", ...taken]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/dup")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		// The 101 taken names use 101 of the 200 name lookups, so the 100-attempt limit answers first.
		// A wider selection runs out of lookups instead and gets the other message.
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			progress: { completed: 0 },
			errorMessage: "No free copy name found",
		});
		expect(await get_node(fixture, "/target/dup-copy-101")).toBeNull();
	});

	test("allocates a free counter for selected items with the same name", async () => {
		const fixture = await create_folder_fixture(["/first/report", "/second/report", "/target/report-copy-1"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/first/report")!, folders.get("/second/report")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(waiting.conflicts).toHaveLength(1);
		expect(await get_node(fixture, "/target/report")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: "keep_both", folder: "keep_both" },
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 2 } },
		});
		expect(await get_node(fixture, "/target/report")).not.toBeNull();
		expect(await get_node(fixture, "/target/report-copy-2")).not.toBeNull();
	});

	test("rejects a stale answer and skips a whole folder without merging", async () => {
		const fixture = await create_folder_fixture([
			"/source",
			"/source/child/deep",
			"/target/source",
			"/target/source/keep",
		]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting).toMatchObject({
			activity: { status: "awaiting_input", progress: { total: 3, completed: 0, blocked: 1 } },
		});
		const resolution = {
			membershipId: db.membershipId,
			runId,
			revision: waiting.revision,
			choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "skip" as const }],
			applyToRemaining: { file: null, folder: null },
		};
		expect(
			(await asUser.mutation(api.files_transfer.resolve_conflicts, { ...resolution, revision: waiting.revision - 1 }))
				._nay?.message,
		).toBe("The conflicts changed. Review them again.");
		expect((await asUser.mutation(api.files_transfer.resolve_conflicts, resolution))._nay).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 0, skipped: 3, blocked: 0 } },
		});
		expect(await get_node(fixture, "/target/source/child")).toBeNull();
		expect((await get_node(fixture, "/target/source/keep"))?._id).toBe(folders.get("/target/source/keep"));
		expect((await get_node(fixture, "/source/child/deep"))?._id).toBe(folders.get("/source/child/deep"));
	});

	test("refuses Merge for the remaining pasted folders", async () => {
		const fixture = await create_folder_fixture(["/source", "/target/source"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_parentItem", (q) => q.eq("runId", runId).eq("parentItemId", null))
				.unique(),
		);

		expect(
			await asUser.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: db.membershipId,
				runId,
				revision: waiting.revision,
				choices: [{ itemId: item!._id, choice: "keep_both" }],
				applyToRemaining: { file: null, folder: "merge" },
			}),
		).toEqual({ _nay: { message: "A pasted folder cannot merge into another folder" } });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item!._id))).toMatchObject({ state: "conflict" });
	});
});
