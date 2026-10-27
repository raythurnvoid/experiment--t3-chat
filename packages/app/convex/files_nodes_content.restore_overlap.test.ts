import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { mock_nodes_content_storage, objects } from "./files_nodes_content.setup.test.ts";
import { add_member } from "./files_pending_overlay.setup.test.ts";
import { upsert_file_pending_update_public_for_test } from "./files_pending_updates.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_db_get_review_state,
	test_finish_pending_update_run,
	test_finish_transfer_run,
	test_meta_search,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_move_content_db_abort, files_move_content_db_finish } from "./files_move_content_db.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import { files_saved_placement_db_get_proposal } from "../server/files-saved-placement.ts";
import { files_u8_to_array_buffer } from "../shared/files.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(path = "/overlap.txt", text = "Original text\n") {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path,
		textContent: text,
	});
	const snapshotId = await t.run(async (ctx) => (await ctx.db.query("files_snapshots").first())!._id);
	const live = async () => {
		const args = { membershipId: db.membershipId, nodeId };
		const snapshot = (await asUser.action(api.files_yjs_load.yjs_prepare_doc_last_snapshot, args))!;
		const updates = (await asUser.query(api.files_yjs_load.yjs_get_incremental_updates, args))!;
		expect(updates.yjsLastSequenceId).toBe(snapshot.yjsLastSequenceId);
		const asset = (await t.run((ctx) => ctx.db.get("files_r2_assets", snapshot.snapshot.assetId)))!;
		const doc = new YjsDoc();
		applyUpdate(doc, new Uint8Array(await new Response(objects.get(asset.r2Key!)).arrayBuffer()));
		for (const update of [...updates.updates].reverse()) applyUpdate(doc, new Uint8Array(update.update));
		return { doc, snapshot };
	};
	const edit = async (text: string, replace = false) => {
		const { doc, snapshot } = await live();
		const vector = encodeStateVector(doc);
		const previous = files_yjs_doc_get_text({ yjsDoc: doc, rootKind: snapshot.textKind });
		if (previous._nay) throw new Error(previous._nay.message);
		expect(
			files_yjs_doc_update_from_text({
				mut_yjsDoc: doc,
				rootKind: snapshot.textKind,
				text: replace ? text : `${text}${previous._yay}`,
			})._nay,
		).toBeUndefined();
		const result = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: snapshot.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(doc, vector)),
			sessionId: "restore-overlap-edit",
		});
		doc.destroy();
		expect(result._nay).toBeUndefined();
	};
	const restore = (versionId = snapshotId) =>
		asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: versionId,
			sessionId: "restore-overlap",
		});
	const read = (readPath = path, includePending = false) =>
		asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			subject: { kind: "user", userId: db.userId, plugin: null },
			path: readPath,
			includePending,
		});
	const expect_content = async (text: string, readPath = path, message = "later cleanup keeps restored text") => {
		expect((await read(readPath))?.content, message).toBe(text);
		const { doc, snapshot } = await live();
		expect(
			files_yjs_doc_get_text({ yjsDoc: doc, rootKind: snapshot.textKind }),
			"later cleanup keeps the same live Yjs content",
		).toEqual({ _yay: text });
		doc.destroy();
	};
	return { t, db, asUser, scope, nodeId, snapshotId, live, edit, restore, read, expect_content };
}

async function start_move(f: Awaited<ReturnType<typeof fixture>>, targetParentId?: Id<"files_nodes">) {
	if (!targetParentId) {
		const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		targetParentId = folder._yay.nodeId;
	}
	// Expose completed transaction boundaries with one file.
	const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
	const started = await f.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [f.nodeId],
		targetParentId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await f.asUser.mutation(api.files_transfer.seal, { membershipId: f.db.membershipId, runId })).toEqual({
		_yay: null,
	});
	const cohort = () =>
		f.t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.order("desc")
				.first(),
		);
	const step = async () => {
		const current = await cohort();
		if (current)
			await f.t.action(internal.files_move_run.run, {
				cohortId: current._id,
				step: current.step,
				runGeneration: current.runJob?.generation ?? null,
				mode: "step",
			});
		else {
			const activity = await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
			if (activity?.status === "awaiting_input") {
				const run = (await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))!;
				const conflicts = (await f.asUser.query(api.files_transfer_status.list_items, {
					membershipId: f.db.membershipId,
					runId,
					state: "conflict",
					paginationOpts: { cursor: null, numItems: 1 },
				}))!;
				const item = conflicts.page[0]!;
				expect(
					await f.asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: f.db.membershipId,
						runId,
						revision: run.revision,
						choices: [
							{
								itemId: item.itemId,
								choice: "replace",
								reviewedTarget: item.conflict!.target!,
								reviewedVersion: item.conflict!.version,
							},
						],
						applyToRemaining: { file: null, folder: null },
					}),
				).toEqual({ _yay: null });
			}
			await f.t.mutation(internal.files_transfer.advance, { runId });
		}
	};
	const finish = async () => {
		join.mockRestore();
		await test_finish_transfer_run(f.asUser, runId);
	};
	return { runId, cohort, step, finish };
}

async function read_draft(ctx: QueryCtx, id: Id<"files_pending_updates">) {
	const proposal = (await files_saved_placement_db_get_proposal(ctx.db, id))!;
	const content = proposal.content!;
	const states = await Promise.all(
		[content.baseStateId, content.stagedStateId, content.unstagedStateId].map((id) =>
			ctx.db.get("files_pending_update_yjs_states", id),
		),
	);
	const pages = await Promise.all(
		states.map((state) =>
			ctx.db
				.query("files_pending_update_yjs_state_pages")
				.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state!._id))
				.collect(),
		),
	);
	const expiryCheck = await ctx.db
		.query("files_pending_update_expiry_checks")
		.withIndex("by_organization_workspace_user", (q) =>
			q
				.eq("organizationId", proposal.organizationId)
				.eq("workspaceId", proposal.workspaceId)
				.eq("userId", proposal.userId),
		)
		.unique();
	return { proposal, states, pages, expiryCheck };
}

async function start_review(
	f: Awaited<ReturnType<typeof fixture>>,
	options: { unchanged?: boolean; independent?: boolean; accepted?: string } = {},
) {
	const accepted = options.accepted ?? (options.unchanged ? "Later edit\nOriginal text\n" : "Accepted text\n");
	const proposed = await upsert_file_pending_update_public_for_test(f.asUser, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		stagedMarkdown: accepted,
		unstagedMarkdown: `${accepted}Private remainder\n`,
	});
	if (proposed._nay) throw new Error(proposed._nay.message);
	const proposal = (await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", f.db.userId).eq("target.kind", "saved").eq("target.id", f.nodeId),
			)
			.unique(),
	))!;
	const items = [
		{
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: proposal.content!.stagedStateId as Id<"files_pending_update_yjs_states"> | null,
		},
	];
	if (options.independent) {
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			kind: "folder",
			path: "/independent",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected an independent folder proposal");
		const other = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!)))!;
		items.push({ pendingUpdateId: other._id, reviewedRevision: other.revision, selectedContentStateId: null });
	}
	const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: items.length,
		items,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(
		await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 100; pass++) {
		const state = await f.t.run((ctx) => test_db_get_review_state(ctx, runId));
		if (state.job) {
			vi.setSystemTime(Math.max(Date.now(), state.job.nextAttemptAt));
			await f.t.mutation(internal.files_pending_overlay.run_job, {
				kind: state.job.kind,
				key: state.job.key,
				nextAttemptAt: state.job.nextAttemptAt,
			});
		} else if (state.run.step === "planning")
			await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: state.run.fence });
		else break;
		if (pass === 99) throw new Error("Review planning did not finish");
	}
	await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
	const state = async () =>
		f.t.run(async (ctx) => {
			const cohort = (await ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
				.first())!;
			const content = await ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", f.nodeId))
				.unique();
			const held = await ctx.db
				.query("files_move_source_reservations")
				.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", f.nodeId))
				.unique();
			return { cohort, content, held };
		});
	const step = async () => {
		const { cohort } = await state();
		await f.t.action(internal.files_move_run.run, {
			cohortId: cohort._id,
			step: cohort.step,
			runGeneration: cohort.runJob?.generation ?? null,
			mode: "step",
		});
	};
	const until = async (matches: (current: Awaited<ReturnType<typeof state>>) => boolean) => {
		for (let pass = 0; pass < 200; pass++) {
			const current = await state();
			if (matches(current)) return current;
			if (current.cohort.phase === "complete") throw new Error("Review finished before the requested boundary");
			await step();
		}
		throw new Error("Review did not reach the requested boundary");
	};
	const finish = async () => {
		join.mockRestore();
		await test_finish_pending_update_run(f.asUser, runId, { stepwise: true });
	};
	return { runId, activityId, proposal, accepted, state, step, until, finish };
}

test.each(["before", "after"] as const)("Restore during Move %s publication keeps restored content", async (when) => {
	const f = await fixture();
	await f.edit("Later edit\n");
	const move = await start_move(f);
	let reached = false;
	for (let pass = 0; pass < 100; pass++) {
		const cohort = await move.cohort();
		const reservation = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_source_reservations")
				.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", f.nodeId))
				.unique(),
		);
		if (cohort && reservation && (when === "before" ? cohort.publishedAt === null : cohort.publishedAt !== null)) {
			reached = true;
			break;
		}
		await move.step();
	}
	expect(reached, "the native Move reaches the requested held boundary").toBe(true);
	await expect(f.restore(), "Restore succeeds while its exact target is held").resolves.toEqual({ _yay: null });
	await move.finish();
	await f.expect_content(
		"Original text\n",
		"/dest/overlap.txt",
		"Move still completes at its destination with restored text",
	);
	expect(await f.read("/overlap.txt"), "the old path no longer names the moved file").toBeNull();
});

test("Restore before a ready Move publishes keeps current frontmatter searchable at the destination", async () => {
	const original = "---\nphase: original\n---\n\nOriginal text\n";
	const f = await fixture("/overlap.md", original);
	const observer = await f.t.run((ctx) => add_member(ctx, f.scope, "overlap-denied-reader"));
	const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path: "dest",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	expect(
		await f.asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: folder._yay.nodeId,
		}),
	).toEqual({ _yay: null });
	await f.edit("---\nphase: later\n---\n\nLater text\n", true);
	expect(
		(
			await f.asUser.action(api.r2.create_signed_download_url, {
				membershipId: f.db.membershipId,
				fileNodeId: f.nodeId,
			})
		)._nay,
	).toBeUndefined();
	expect(
		(
			await f.t.mutation(internal.files_metadata.update_entries_by_path, {
				...f.scope,
				path: "/overlap.md",
				set: [{ key: "owner", value: "kept" }],
				remove: [],
			})
		)._nay,
	).toBeUndefined();
	const move = await start_move(f, folder._yay.nodeId);
	for (let pass = 0; pass < 100; pass++) {
		if ((await move.cohort())?.phase === "ready") break;
		await move.step();
		if (pass === 99) throw new Error("Move did not reach ready");
	}
	const ready = (await move.cohort())!;
	expect(ready.publishedAt).toBeNull();
	expect((await f.restore())._nay).toBeUndefined();
	const rewound = (await move.cohort())!;
	expect(rewound.workPhase, "Restore rewinds ready Move to recopy its metadata").toBe("sides");
	await f.t.action(internal.files_move_run.run, {
		cohortId: ready._id,
		step: ready.step,
		runGeneration: ready.runJob?.generation ?? null,
		mode: "step",
	});
	expect(await move.cohort(), "an old ready callback cannot publish after Restore rewinds Move").toEqual(rewound);
	for (let pass = 0; pass < 100; pass++) {
		if ((await move.cohort())?.publishedAt !== null) break;
		await move.step();
		if (pass === 99) throw new Error("Restored Move did not publish");
	}
	const published = (await move.cohort())!;
	expect(published.validatedItemCount, "restaging validates every Move item once").toBe(published.itemCount);
	const check = async () => {
		await f.expect_content(original, "/dest/overlap.md");
		for (const [fieldPath, value] of [
			["frontmatter.phase", "original"],
			["metadata.owner", "kept"],
		]) {
			const found = await test_meta_search(f.t, {
				...f.scope,
				folderPath: "/dest",
				plan: { op: "eq", fieldPath: fieldPath!, value: value! },
			});
			expect(
				found.items.map((item) => item.path),
				"publication exposes current metadata at the destination",
			).toEqual(["/dest/overlap.md"]);
		}
		const old = await test_meta_search(f.t, {
			...f.scope,
			folderPath: "/dest",
			plan: { op: "eq", fieldPath: "frontmatter.phase", value: "later" },
		});
		expect(old.items, "publication never exposes the old frontmatter copy").toEqual([]);
		const restoredFields = await f.t.run((ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", f.scope.organizationId)
						.eq("workspaceId", f.scope.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", f.nodeId),
				)
				.collect(),
		);
		const destinationFields = restoredFields.filter(
			(doc) => doc.path === "/dest/overlap.md" && doc.fieldPath === "frontmatter.phase",
		);
		expect(destinationFields).toHaveLength(2);
		expect(
			destinationFields.map((doc) => doc.sourceKind === "committed" && doc.restrictedScopeNodeId),
			"restaged frontmatter keeps the destination's restricted area",
		).toEqual([folder._yay.nodeId, folder._yay.nodeId]);
		const denied = await test_meta_search(f.t, {
			...observer,
			plan: { op: "eq", fieldPath: "frontmatter.phase", value: "original" },
		});
		expect(denied.items, "a member without destination access cannot find restored frontmatter").toEqual([]);
	};
	await check();
	await move.finish();
	await check();
});

test("Restore after a moving Review publishes writes frontmatter at its selected path", async () => {
	const original = "---\nphase: original\n---\n\nOriginal text\n";
	const f = await fixture("/overlap.md", original);
	const observer = await f.t.run((ctx) => add_member(ctx, f.scope, "overlap-search-reader"));
	const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path: "review-dest",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	expect(
		(
			await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...f.scope,
				target: { kind: "saved", id: f.nodeId },
				destParent: { kind: "saved", id: folder._yay.nodeId },
				destName: "overlap.md",
			})
		)._nay,
	).toBeUndefined();
	const review = await start_review(f, { accepted: "---\nphase: accepted\n---\n\nAccepted text\n" });
	await review.until(({ cohort }) => cohort.publishedAt !== null);
	expect((await f.restore())._nay).toBeUndefined();
	const check = async () => {
		await f.expect_content(original, "/review-dest/overlap.md");
		const found = await test_meta_search(f.t, {
			...observer,
			folderPath: "/review-dest",
			plan: { op: "eq", fieldPath: "frontmatter.phase", value: "original" },
		});
		expect(
			found.items.map((item) => item.path),
			"restored frontmatter uses the published Review path",
		).toEqual(["/review-dest/overlap.md"]);
	};
	await check();
	await review.finish();
	await check();
});

test("a stale Restore does not cancel a later prepared Review", async () => {
	const f = await fixture();
	await f.edit("Later edit\n");
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const fetchMock = vi.mocked(globalThis.fetch);
	const baseFetch = fetchMock.getMockImplementation()!;
	let paused = false;
	fetchMock.mockImplementation(async (input, init) => {
		if (!paused && init?.method === "PUT" && typeof init.body === "string") {
			paused = true;
			started.resolve();
			await release.promise;
		}
		return await baseFetch(input, init);
	});
	const restoring = f.restore();
	await Promise.race([
		started.promise,
		restoring.then(() => {
			throw new Error("Restore ended before upload pause");
		}),
	]);
	let review: Awaited<ReturnType<typeof start_review>>;
	let before: Awaited<ReturnType<Awaited<ReturnType<typeof start_review>>["state"]>>;
	try {
		await f.edit("Newer edit\n");
		review = await start_review(f);
		before = await review.until(({ content }) => content?.sealed === true);
	} finally {
		release.resolve();
	}
	expect(await restoring, "the earlier Restore refuses its changed content input").toMatchObject({
		_nay: { message: "This file changed while the snapshot was being restored. Try again." },
	});
	fetchMock.mockImplementation(baseFetch);
	expect(await review!.state(), "a refused Restore leaves the prepared Review unchanged").toEqual(before!);
	await review!.finish();
	await f.expect_content("Accepted text\n");
});

test("Restore during abort keeps its bytes and exact draft through every cleanup part", async () => {
	const f = await fixture();
	await f.edit("Later edit\n");
	const review = await start_review(f);
	const prepared = await review.until(({ content }) => content?.sealed === true);
	const before = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
	expect(
		(
			await f.asUser.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: review.activityId,
			})
		)._nay,
	).toBeUndefined();
	const aborting = await review.until(({ content }) => content?.phaseCursor?.startsWith("abort:") === true);
	expect((await f.restore())._nay, "Restore succeeds during partial abort cleanup").toBeUndefined();
	expect((await review.state()).cohort.errorCode, "Restore keeps the existing abort reason").toBe(
		aborting.cohort.errorCode,
	);
	const parts = new Set<number>();
	for (let pass = 0; pass < 100; pass++) {
		const current = await review.state();
		if (current.content?.phaseCursor === "abort:done") break;
		const part = current.content?.phaseCursor?.match(/^abort:(\d+)\|$/)?.[1];
		if (part !== undefined) parts.add(Number(part));
		await review.step();
		await f.expect_content("Original text\n");
	}
	expect(
		[...parts].sort((a, b) => a - b),
		"abort visits every side cleanup part",
	).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
	expect(
		await test_run_with_flush(f.t, (ctx) =>
			files_move_content_db_abort(ctx, {
				cohortId: prepared.cohort._id,
				contentId: prepared.content!._id,
				fence: prepared.cohort.fence,
				attemptFence: prepared.cohort.attemptFence,
			}),
		),
	).toMatchObject({ _yay: { done: true } });
	expect(
		await f.t.mutation(internal.files_pending_updates.stage_cohort_prepared_content, {
			cohortContent: {
				cohortId: prepared.cohort._id,
				contentId: prepared.content!._id,
				fence: prepared.cohort.fence,
				attemptFence: prepared.cohort.attemptFence,
				preparationFence: prepared.content!.preparationFence,
			},
			prepared: prepared.content!.prepared!,
		}),
		"late prepared content cannot publish after abort",
	).toMatchObject({ _nay: { name: "stopped" } });
	await review.finish();
	await f.expect_content("Original text\n");
	const after = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
	expect(after.proposal.content).toEqual(before.proposal.content);
	expect(after.proposal.expiresAt).toBe(before.proposal.expiresAt);
	expect(after.states).toEqual(before.states);
	expect(after.pages).toEqual(before.pages);
});

test("a ready Move cannot replace an occupant restored after its content check", async () => {
	const f = await fixture();
	const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path: "dest",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	const occupantId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/dest/overlap.txt",
		textContent: "Occupant original\n",
	});
	const snapshot = (await f.t.run((ctx) =>
		ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", f.scope.organizationId)
					.eq("workspaceId", f.scope.workspaceId)
					.eq("fileNodeId", occupantId),
			)
			.first(),
	))!;
	expect(
		(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.db.membershipId,
				nodeId: occupantId,
				acknowledgeDropCollaborativeHistory: true,
			})
		)._nay,
	).toBeUndefined();
	expect(
		(
			await f.asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.db.membershipId,
				nodeId: occupantId,
				text: "Occupant changed\n",
			})
		)._nay,
	).toBeUndefined();
	const move = await start_move(f, folder._yay.nodeId);
	for (let pass = 0; pass < 100; pass++) {
		if ((await move.cohort())?.phase === "ready") break;
		await move.step();
		if (pass === 99) throw new Error("Replacement Move did not reach ready");
	}
	expect((await move.cohort())?.publishedAt).toBeNull();
	expect(
		await f.asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: f.db.membershipId,
			nodeId: occupantId,
			snapshotId: snapshot._id,
			sessionId: "restore-occupant",
		}),
		"Restore succeeds on the held replacement occupant",
	).toEqual({ _yay: null });
	expect(await move.cohort(), "changed replacement consent stops publication even after validation").toMatchObject({
		phase: "aborting",
		publishedAt: null,
	});
	await move.finish();
	await f.expect_content("Original text\n");
	expect(
		(await f.read("/dest/overlap.txt"))?.content,
		"Move cannot replace the restored occupant using old consent",
	).toBe("Occupant original\n");
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", occupantId))).toMatchObject({ archiveOperationId: null });
});

test("shape-changing Restore keeps new pointers when unchanged Review shared the old pointers", async () => {
	const f = await fixture();
	await f.edit("Later edit\n");
	const richText = "Restored rich text\n";
	// A retained version can have another text shape, as in the existing Restore shape matrix.
	const richVersionId = await f.t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: f.scope.organizationId,
			workspaceId: f.scope.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: new TextEncoder().encode(richText).byteLength,
			createdBy: f.scope.userId,
			updatedAt: Date.now(),
		});
		const r2Key = `test/restore-shape-${assetId}`;
		objects.set(r2Key, richText);
		await ctx.db.patch("files_r2_assets", assetId, { r2Key });
		return await ctx.db.insert("files_snapshots", {
			organizationId: f.scope.organizationId,
			workspaceId: f.scope.workspaceId,
			fileNodeId: f.nodeId,
			assetId,
			createdBy: f.scope.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});
	});
	const review = await start_review(f, { unchanged: true });
	const published = await review.until(({ cohort }) => cohort.publishedAt !== null);
	const content = published.content!;
	const before = (await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", content.beforeHeadId!)))!;
	expect(content.afterSnapshotId, "unchanged Review shares the original snapshot").toBe(before.yjsSnapshotId);
	expect(content.afterSequence?.lastSequenceId, "unchanged Review shares the public sequence ID").toBe(
		before.yjsLastSequenceId,
	);
	const oldSnapshot = (await f.t.run((ctx) => ctx.db.get("files_yjs_snapshots", before.yjsSnapshotId!)))!;
	const remainder = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
	expect((await f.restore(richVersionId))._nay, "replacement Restore succeeds under published Review").toBeUndefined();
	const restored = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
	expect(restored.textKind).toBe("rich_text");
	expect(restored.yjsSnapshotId, "shape rotation keeps the snapshot identity").toBe(before.yjsSnapshotId);
	const restoredSnapshot = (await f.t.run((ctx) => ctx.db.get("files_yjs_snapshots", restored.yjsSnapshotId!)))!;
	expect(restoredSnapshot.assetId).not.toBe(oldSnapshot.assetId);
	expect(restored.yjsLastSequenceId).not.toBe(before.yjsLastSequenceId);
	for (let pass = 0; pass < 100; pass++) {
		if ((await review.state()).content?.phaseCursor === "finish:done") break;
		await review.step();
		await f.expect_content(richText);
	}
	expect((await review.state()).content?.phaseCursor, "content cleanup reaches finish:done after shape rotation").toBe(
		"finish:done",
	);
	await review.finish();
	await f.expect_content(richText);
	const after = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
	expect(after.yjsSnapshotId, "old cleanup cannot delete or restore the new snapshot pointer").toBe(
		restored.yjsSnapshotId,
	);
	expect(after.yjsLastSequenceId).toBe(restored.yjsLastSequenceId);
	expect(
		(await f.t.run((ctx) => ctx.db.get("files_yjs_snapshots", after.yjsSnapshotId!)))?.assetId,
		"old cleanup keeps the rotated snapshot bytes",
	).toBe(restoredSnapshot.assetId);
	const kept = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
	expect(kept.proposal.content).toEqual(remainder.proposal.content);
	expect(kept.pages).toEqual(remainder.pages);
});

test("stored-byte Restore keeps its bytes when unchanged Review shared old stats", async () => {
	const f = await fixture();
	expect(
		(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				acknowledgeDropCollaborativeHistory: true,
			})
		)._nay,
	).toBeUndefined();
	const bytes = new Uint8Array([0x41, 0x0d, 0x0a, 0x00, 0xff]);
	// Keep a stored-byte version, as in the existing Restore shape matrix.
	const storedVersionId = await f.t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: f.scope.organizationId,
			workspaceId: f.scope.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: bytes.byteLength,
			createdBy: f.scope.userId,
			updatedAt: Date.now(),
		});
		const r2Key = `test/restore-stored-${assetId}`;
		objects.set(r2Key, bytes);
		await ctx.db.patch("files_r2_assets", assetId, { r2Key });
		return await ctx.db.insert("files_snapshots", {
			organizationId: f.scope.organizationId,
			workspaceId: f.scope.workspaceId,
			fileNodeId: f.nodeId,
			assetId,
			createdBy: f.scope.userId,
			archivedAt: 0,
			contentType: "text/html",
			yjsRootKind: null,
			collaborationEnabled: false,
		});
	});
	vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
		objects.set(args.destinationKey, objects.get(args.sourceKey)!);
		return { outcome: "copied", size: bytes.byteLength, etag: "stored-overlap" };
	});
	const review = await start_review(f, { accepted: "Original text\n", unchanged: true });
	const published = await review.until(({ cohort }) => cohort.publishedAt !== null);
	const content = published.content!;
	const before = (await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", content.beforeHeadId!)))!;
	expect(before.statsId).not.toBeNull();
	expect(content.afterStatsId, "unchanged Review shares its original stats").toBe(before.statsId);
	const remainder = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
	expect(
		(await f.restore(storedVersionId))._nay,
		"stored-byte Restore succeeds under published Review",
	).toBeUndefined();
	const restored = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
	expect(restored).toMatchObject({ textKind: null, statsId: null, yjsSnapshotId: null });
	expect(await f.t.run((ctx) => ctx.db.get("file_stats", before.statsId!))).toBeNull();
	const check = async () => {
		const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
		expect(node.assetId, "cleanup keeps the restored stored-byte asset").toBe(restored.assetId);
		expect(node.statsId).toBeNull();
		const asset = (await f.t.run((ctx) => ctx.db.get("files_r2_assets", node.assetId!)))!;
		expect(new Uint8Array(await new Response(objects.get(asset.r2Key!)).arrayBuffer())).toEqual(bytes);
	};
	for (let pass = 0; pass < 100; pass++) {
		if ((await review.state()).content?.phaseCursor === "finish:done") break;
		await review.step();
		await check();
	}
	expect(
		(await review.state()).content?.phaseCursor,
		"content cleanup reaches finish:done after stored-byte Restore",
	).toBe("finish:done");
	await review.finish();
	await check();
	const kept = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
	expect(kept.proposal.content).toEqual(remainder.proposal.content);
	expect(kept.pages).toEqual(remainder.pages);
});

test.each(["before preparation", "after preparation"] as const)(
	"Restore %s blocks only its stale Review group",
	async (when) => {
		const f = await fixture();
		await f.edit("Later edit\n");
		const review = await start_review(f, { independent: true });
		const reached = await review.until(
			({ cohort, content, held }) =>
				!!held &&
				cohort.publishedAt === null &&
				(when === "before preparation" ? !content?.prepared : content?.sealed === true),
		);
		expect(reached.cohort.publishedAt).toBeNull();
		const before = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
		if (when === "after preparation") {
			const { doc } = await f.live();
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
						...f.scope,
						nodeId: f.nodeId,
						kind: "snapshot_restore",
						update: files_u8_to_array_buffer(encodeStateAsUpdate(doc)),
					})
				)._nay,
			).toBeUndefined();
			doc.destroy();
			expect(await review.state(), "trusted Restore staging alone leaves prepared Review unchanged").toEqual(reached);
		}
		await expect(f.restore(), "Restore succeeds while its exact target is held").resolves.toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) => read_draft(ctx, review.proposal._id)),
			"Restore keeps the exact held draft family",
		).toEqual(before);
		expect((await review.state()).cohort, "stale prepared Review cannot publish after Restore").toMatchObject({
			phase: "aborting",
			publishedAt: null,
			errorCode: "needs_review",
		});
		await review.finish();
		await f.expect_content("Original text\n");
		const activity = await f.t.run((ctx) => ctx.db.get("activities", review.activityId));
		expect(activity, "an independent Review group still completes").toMatchObject({
			status: "partial",
			progress: { completed: 1, blocked: 1 },
		});
		expect(
			(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).some((node) => node.path === "/independent"),
		).toBe(true);
		const after = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
		expect(after.proposal.content).toEqual(before.proposal.content);
		expect(after.pages).toEqual(before.pages);
		expect((await review.state()).content?.acceptedVersionSnapshotId ?? null).toBeNull();
	},
);

test.each([false, true])(
	"published Review cleanup preserves Restore and drafts (unchanged candidate: %s)",
	async (unchanged) => {
		const f = await fixture();
		await f.edit("Later edit\n");
		const other = await f.t.run((ctx) => add_member(ctx, f.scope, "overlap-other-owner"));
		const member = (await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.filter((q) => q.eq(q.field("userId"), other.userId))
				.first(),
		))!;
		const otherUser = f.t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			(
				await upsert_file_pending_update_public_for_test(otherUser, {
					membershipId: member._id,
					nodeId: f.nodeId,
					stagedMarkdown: "Other staged\n",
					unstagedMarkdown: "Other unstaged\n",
				})
			)._nay,
		).toBeUndefined();
		const otherProposal = (await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", other.userId).eq("target.kind", "saved").eq("target.id", f.nodeId),
				)
				.unique(),
		))!;
		const otherBefore = await f.t.run((ctx) => read_draft(ctx, otherProposal._id));
		const review = await start_review(f, { unchanged });
		const published = await review.until(({ cohort }) => cohort.publishedAt !== null);
		const content = published.content!;
		expect(content.sealed).toBe(true);
		const remainder = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
		await expect(f.restore(), "Restore succeeds before published Review cleanup").resolves.toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) => read_draft(ctx, review.proposal._id)),
			"Restore preserves the exact effective remainder",
		).toEqual(remainder);
		await f.expect_content("Original text\n");
		const versions = await f.t.run(async (ctx) =>
			Promise.all(
				(await ctx.db.query("files_snapshots").collect()).map(async (snapshot) => ({
					snapshot,
					asset: (await ctx.db.get("files_r2_assets", snapshot.assetId))!,
				})),
			),
		);
		const acceptedBackup = versions.find(({ asset }) => objects.get(asset.r2Key!) === review.accepted)!.snapshot._id;
		const parts = new Set<number>();
		let expected = "Original text\n";
		for (let pass = 0; pass < 100; pass++) {
			const current = await review.state();
			if (current.content?.phaseCursor === "finish:done") break;
			const part = current.content?.phaseCursor?.match(/^finish:(\d+)\|$/)?.[1];
			if (part !== undefined && !parts.has(Number(part))) {
				parts.add(Number(part));
				expected = expected === "Original text\n" ? review.accepted : "Original text\n";
				vi.setSystemTime(Date.now() + 10_000);
				expect(
					(await f.restore(expected === review.accepted ? acceptedBackup : f.snapshotId))._nay,
					"Restore succeeds at each reached cleanup boundary",
				).toBeUndefined();
			}
			await review.step();
			await f.expect_content(expected);
		}
		expect(
			[...parts].sort((a, b) => a - b),
			"the test visits every completed side cleanup part",
		).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
		const beforeReplay = await f.t.run(async (ctx) => ({
			history: await ctx.db.query("files_snapshots").collect(),
			billing: await ctx.db.query("billing_usage_event_outbox").collect(),
			quotas: await ctx.db.query("quotas").collect(),
		}));
		const finished = (await review.state()).content!;
		for (const role of ["previousVersion", "acceptedVersion"] as const) {
			const version = finished[role];
			if (!version) continue;
			const receiptId =
				role === "previousVersion" ? finished.previousVersionSnapshotId : finished.acceptedVersionSnapshotId;
			const receipts = beforeReplay.history.filter((snapshot) => snapshot._id === receiptId);
			expect(receipts, "cleanup records each captured version once").toHaveLength(1);
			expect(receipts[0]?.assetId).toBe(version.assetId);
			const asset = (await f.t.run((ctx) => ctx.db.get("files_r2_assets", version.assetId)))!;
			expect(await new Response(objects.get(asset.r2Key!)).text(), "captured history keeps its original bytes").toBe(
				role === "previousVersion" ? "Later edit\nOriginal text\n" : review.accepted,
			);
		}
		expect(
			await test_run_with_flush(f.t, (ctx) =>
				files_move_content_db_finish(ctx, {
					cohortId: published.cohort._id,
					contentId: content._id,
					fence: published.cohort.fence,
					attemptFence: published.cohort.attemptFence,
				}),
			),
		).toMatchObject({ _yay: { done: true } });
		expect(
			await f.t.run(async (ctx) => ({
				history: await ctx.db.query("files_snapshots").collect(),
				billing: await ctx.db.query("billing_usage_event_outbox").collect(),
				quotas: await ctx.db.query("quotas").collect(),
			})),
			"retry creates no second history, quota, or billing receipt",
		).toEqual(beforeReplay);
		await review.finish();
		await f.expect_content(expected);
		expect(
			await f.t.run((ctx) => read_draft(ctx, otherProposal._id)),
			"other owners keep their exact draft records and bytes",
		).toEqual(otherBefore);
		const after = await f.t.run((ctx) => read_draft(ctx, review.proposal._id));
		expect(after.proposal.content, "cleanup keeps the partial remainder state IDs and accepted base").toEqual(
			remainder.proposal.content,
		);
		expect(after.proposal.expiresAt).toBe(remainder.proposal.expiresAt);
		expect(after.pages, "cleanup keeps every partial remainder byte page").toEqual(remainder.pages);
		expect(after.states.every((state) => state?.owner.kind === "active")).toBe(true);
		await f.edit("After cleanup\n");
		await f.expect_content(`After cleanup\n${expected}`);
	},
);
