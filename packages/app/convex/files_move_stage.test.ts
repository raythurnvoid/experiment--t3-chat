import { Workpool } from "@convex-dev/workpool";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { advance } from "./files_move_cohorts.ts";
import { advance_stage, files_move_content_action_prepare } from "./files_move_content.ts";
import { run } from "./files_move_run.ts";
import { budget_recorder, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import {
	finish_review,
	fixture,
	mock_review_storage,
	private_node,
	saved_text,
	start_review,
} from "./files_pending_update_runs_content.setup.test.ts";
import {
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_progress_guard,
	test_spy_handler,
} from "./setup.test.ts";

beforeEach(mock_review_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function member_fixture() {
	const t = test_convex({ transactionLimits: true });
	const owner = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "stage-owner" });
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const member = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "stage-member" });
		return await test_mocks_fill_db_with.membership(ctx, {
			userId,
			organizationName: "personal",
			workspaceName: "home",
		});
	});
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: member.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected the invited stage actor");
	const db = { ...owner, userId: member.userId, membershipId: membership._id };
	const f: Awaited<ReturnType<typeof fixture>> = {
		t,
		db,
		scope: { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId },
		asUser: t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId }),
	};
	return { f, owner, asOwner };
}

async function start_group(f: Awaited<ReturnType<typeof fixture>>, childCount = 0, singleText = "selected text\n") {
	const target = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path: "/target",
	});
	if (target._nay) throw new Error(target._nay.message);
	const drafts: Array<{ proposal: Doc<"files_pending_updates">; path: string; text?: string }> = [];
	if (childCount) {
		const path = "/target/parent";
		drafts.push({ proposal: await private_node({ f, path }), path });
		for (let index = 0; index < childCount; index++) {
			const path = `/target/parent/file-${index}.txt`;
			const text = `file ${index}\n`;
			drafts.push({ proposal: await private_node({ f, path, text }), path, text });
		}
	} else {
		const path = "/target/note.txt";
		const text = singleText;
		drafts.push({ proposal: await private_node({ f, path, text }), path, text });
	}
	const runId = await start_review({ f, proposals: drafts.map((draft) => draft.proposal) });
	await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
	const unit = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_update_run_units")
			.withIndex("by_run_order", (q) => q.eq("runId", runId))
			.unique(),
	);
	if (!unit?.cohortId) throw new Error("Expected the real Review cohort");
	expect(unit).toMatchObject({ kind: "cohort", status: "preparing", itemCount: drafts.length });
	const review = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
	if (!review) throw new Error("Expected the Review Activity");
	return { f, runId, unitId: unit._id, cohortId: unit.cohortId, activityId: review.activity._id, targetId: target._yay.nodeId, drafts };
}

async function ready_stage(initialGroup?: Awaited<ReturnType<typeof start_group>>, captureOldPreparation = false) {
	const group = initialGroup ?? (await start_group(await fixture()));
	const { f, cohortId } = group;
	const progress = test_progress_guard();
	let oldPreparationFence: number | null = null;
	let preparedContentId: Doc<"files_move_cohort_content">["_id"] | null = null;
	for (let pass = 0; pass < 1_000; pass++) {
		const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId));
		if (!cohort) throw new Error("Expected the Review cohort");
		progress(cohort, `Stage ${cohort.workPhase} step ${cohort.step}`);
		const current = { cohortId, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, join: true };
		const pending = await f.t.mutation(internal.files_move_cohorts.advance, current);
		if (preparedContentId) {
			expect(
				pending,
				"prepared content leaves the lean owner without saving another step",
			).toMatchObject({ kind: "stage", contentId: preparedContentId, step: cohort.step });
		}
		if (!pending || pending.kind === "complete") throw new Error("Review ended before a stage request");
		if (pending.kind === "next") continue;
		if (pending.kind !== "prepare" && pending.kind !== "stage") throw new Error("Expected content work before media");
		if (pending.kind === "stage") {
			return {
				...group,
				descriptor: pending,
				oldPreparationFence,
				args: {
					...current,
					step: pending.step,
					contentId: pending.contentId,
					fence: pending.fence,
					attemptFence: pending.attemptFence,
					preparationFence: pending.preparationFence,
				},
			};
		}
		const preparation = {
			cohortId,
			contentId: pending.contentId,
			fence: pending.fence,
			attemptFence: pending.attemptFence,
			runGeneration: current.runGeneration,
		};
		if (captureOldPreparation) {
			const begun = await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, preparation);
			if (begun._nay || begun._yay.done) throw new Error("Expected the earlier preparation token");
			oldPreparationFence = begun._yay.preparationFence;
		}
		expect(await f.t.action((ctx) => files_move_content_action_prepare(ctx, preparation))).toEqual({ _yay: null });
		expect(
			await f.t.mutation(internal.files_move_cohorts.resume, {
				cohortId,
				step: pending.step,
				runGeneration: current.runGeneration,
				error: null,
			}),
		).toEqual({ kind: "next", step: pending.step + 1 });
		preparedContentId = pending.contentId;
	}
	throw new Error("Review did not reach prepared staging");
}

async function stage_state(s: Awaited<ReturnType<typeof ready_stage>>) {
	return await s.f.t.run(async (ctx) => {
		const content = await ctx.db.get("files_move_cohort_content", s.args.contentId);
		if (!content) throw new Error("Expected the prepared content");
		const scope = s.f.scope;
		return {
			cohort: await ctx.db.get("files_move_cohorts", s.cohortId),
			content,
			proposal: await ctx.db.get("files_pending_updates", content.pendingUpdateId),
			node: await ctx.db.get("files_nodes", content.nodeId),
			chunks: await ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("fileNodeId", content.nodeId),
				)
				.collect(),
			plainChunks: await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("fileNodeId", content.nodeId),
				)
				.collect(),
			metadata: await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("sourceKind", "committed").eq("fileNodeId", content.nodeId),
				)
				.collect(),
			quotas: await ctx.db.query("quotas").collect(),
		};
	});
}

async function finish_group(group: Awaited<ReturnType<typeof start_group>>) {
	const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
	const result = await finish_review({ f: group.f, runId: group.runId });
	expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: group.drafts.length } });
	for (const draft of group.drafts) {
		if (draft.proposal.target.kind !== "private") throw new Error("Expected the private target");
		const privateNodeId = draft.proposal.target.id;
		const receipt = await group.f.t.run((ctx) =>
			ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", privateNodeId))
				.unique(),
		);
		if (!receipt) throw new Error("Expected the exact publication receipt");
		expect(receipt.moveView).toBeUndefined();
		const node = await group.f.t.run((ctx) => ctx.db.get("files_nodes", receipt.savedNodeId));
		expect(node).toMatchObject({ path: draft.path, archiveOperationId: null });
		expect(node?.moveCohortId).toBeUndefined();
		if (draft.text !== undefined) expect(await saved_text(group.f, receipt.savedNodeId)).toBe(draft.text);
		expect(await group.f.t.run((ctx) => ctx.db.get("files_pending_updates", draft.proposal._id))).toBeNull();
	}
	await test_drain_billing_usage_event_outbox(group.f.t);
	const events = enqueue.mock.calls
		.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")
		.flatMap((call) => (call[2] as { events: unknown[] }).events);
	expect(events, "each accepted text is charged once").toHaveLength(group.drafts.filter((draft) => draft.text !== undefined).length);
	expect(await group.f.t.run((ctx) => ctx.db.get("files_move_cohorts", group.cohortId))).toMatchObject({
		phase: "complete",
		visibleView: "after",
		errorCode: null,
	});
}

describe("Move content stage route", () => {
	test.each([false, true])("prepared content uses one heavy step (join: %s)", async (join) => {
		const s = await ready_stage();
		const before = await stage_state(s);
		expect(before.content).toMatchObject({ prepared: expect.any(Object), sealed: false });
		expect(
			await s.f.t.mutation(internal.files_move_cohorts.advance, {
				cohortId: s.cohortId,
				step: s.args.step,
				runGeneration: s.args.runGeneration,
				join,
			}),
			"prepared content leaves the lean owner without saving another step",
		).toEqual(s.descriptor);
		expect(await stage_state(s), "the lean owner writes no prepared content").toEqual(before);
		expect(
			await s.f.t.mutation(internal.files_move_content.advance_stage, { ...s.args, join }),
			"a successful content stage saves exactly one step",
		).toEqual({ kind: "next", step: s.args.step + 1 });
		const committed = await stage_state(s);
		expect(committed.cohort?.step).toBe(s.args.step + 1);
		expect(committed.content).not.toEqual(before.content);
		await finish_group(s);
	});

	test("wrapped content stage keeps a quarter of all seven limits", async () => {
		const member = await member_fixture();
		const text = "a\t".repeat(350_000);
		const group = await start_group(member.f, 0, text);
		let current = await ready_stage(group);
		const { peaks, record } = budget_recorder();
		test_spy_handler(advance_stage, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			// The registered wrapper has finished its overlay flush.
			record("wrapped content stage", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		for (let pass = 0; pass < 1_000; pass++) {
			expect(await member.f.t.mutation(internal.files_move_content.advance_stage, { ...current.args, join: false }))
				.toEqual({ kind: "next", step: current.args.step + 1 });
			const content = await member.f.t.run((ctx) => ctx.db.get("files_move_cohort_content", current.args.contentId));
			if (content?.sealed) break;
			current = await ready_stage(group);
		}
		const content = await member.f.t.run((ctx) => ctx.db.get("files_move_cohort_content", current.args.contentId));
		expect(content?.sealed, "the measured wrapped stages finish the prepared body").toBe(true);
		const peak = peaks.get("wrapped content stage");
		expect(peak?.calls, "the large draft uses several measured stage calls").toBeGreaterThan(1);
		expect(Object.keys(peak!.measured).sort(), "every wrapped stage measures all seven Convex metrics").toEqual([
			"bytesRead",
			"bytesWritten",
			"databaseQueries",
			"documentsRead",
			"documentsWritten",
			"functionsScheduled",
			"scheduledFunctionArgsBytes",
		]);
		expect(peak!.measured.bytesRead, "the measurement includes the full prepared text read").toBeGreaterThan(700_000);
		expect(peak!.measured.scheduledFunctionArgsBytes, "the wrapped stage measures real scheduled args").toBeGreaterThan(0);
		console.info("700 KB wrapped content stage peaks", JSON.stringify(Object.fromEntries(peaks)));
		await finish_group(group);
	});

	test.each(["step", "chain"] as const)("successful content stage needs no resume (%s)", async (mode) => {
		const s = await ready_stage();
		const calls: Array<{ name: string; args: unknown; result: unknown }> = [];
		let firstCommittedStep: number | null = null;
		test_spy_handler(run, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const name = getFunctionName(mutationArgs[0]);
				const result = await runMutation(mutationArgs[0], mutationArgs[1], mutationArgs[2]);
				calls.push({ name, args: mutationArgs[1], result });
				if (name === "files_move_content:advance_stage" && firstCommittedStep === null)
					firstCommittedStep = (await s.f.t.run((ctx) => ctx.db.get("files_move_cohorts", s.cohortId)))!.step;
				return result;
			});
			return await handler(ctx, args);
		});
		await s.f.t.action(internal.files_move_run.run, {
			cohortId: s.cohortId,
			step: s.args.step,
			runGeneration: s.args.runGeneration,
			mode,
		});
		expect(calls[0]).toMatchObject({ name: "files_move_cohorts:advance", result: s.descriptor });
		expect(calls[1]).toEqual({
			name: "files_move_content:advance_stage",
			args: { ...s.args, join: mode === "chain" },
			result: { kind: "next", step: s.args.step + 1 },
		});
		expect(firstCommittedStep).toBe(s.args.step + 1);
		expect(calls[2]?.name, "successful content stage needs no resume").toBe(
			mode === "step" ? "files_move_cohorts:handoff" : "files_move_cohorts:advance",
		);
		await finish_group(s);
	});

	test("a repeated stage request changes no committed work", async () => {
		const s = await ready_stage();
		expect(await s.f.t.mutation(internal.files_move_content.advance_stage, s.args)).toEqual({
			kind: "next",
			step: s.args.step + 1,
		});
		const committed = await stage_state(s);
		expect(await s.f.t.mutation(internal.files_move_content.advance_stage, s.args)).toBeNull();
		expect(await stage_state(s), "a repeated stage request changes no committed work").toEqual(committed);
		await finish_group(s);
	});

	test("an earlier preparation fence cannot stage current content", async () => {
		const s = await ready_stage(await start_group(await fixture()), true);
		if (s.oldPreparationFence === null) throw new Error("Expected the earlier real preparation token");
		expect(s.oldPreparationFence).toBeLessThan(s.args.preparationFence);
		const before = await stage_state(s);
		expect(
			await s.f.t.mutation(internal.files_move_content.advance_stage, { ...s.args, preparationFence: s.oldPreparationFence }),
			"an earlier preparation fence cannot stage current content",
		).toBeNull();
		expect(await stage_state(s), "an earlier preparation fence changes no current rows").toEqual(before);
		expect(await s.f.t.mutation(internal.files_move_content.advance_stage, s.args)).toEqual({
			kind: "next",
			step: s.args.step + 1,
		});
		await finish_group(s);
	});

	test("heavy stage is bound to the selected content item", async () => {
		const group = await start_group(await fixture(), 1);
		const first = await ready_stage(group);
		let current = first;
		for (let pass = 0; pass < 100 && current.args.contentId === first.args.contentId; pass++) {
			await current.f.t.mutation(internal.files_move_content.advance_stage, current.args);
			current = await ready_stage(group);
		}
		expect(current.args.contentId, "a second real selected content exists").not.toBe(first.args.contentId);
		const before = await stage_state(current);
		expect(
			await current.f.t.mutation(internal.files_move_content.advance_stage, { ...current.args, contentId: first.args.contentId }),
			"heavy stage is bound to the selected content item",
		).toBeNull();
		expect(await stage_state(current)).toEqual(before);
		await finish_group(current);
	});

	test.each(["stop", "role", "lifetime", "scope", "policy"] as const)(
		"content stage checks fresh public authority (%s)",
		async (change) => {
			const member = await member_fixture();
			const s = await ready_stage(await start_group(member.f));
			if (change === "stop") {
				expect(await s.f.asUser.mutation(api.activities.request_stop, { membershipId: s.f.db.membershipId, activityId: s.activityId })).toEqual({ _yay: null });
			} else if (change === "role") {
				const organization = await s.f.t.run((ctx) => ctx.db.get("organizations", s.f.db.organizationId));
				if (!organization?.defaultWorkspaceId) throw new Error("Expected the organization home");
				expect(await member.asOwner.mutation(api.access_control.set_user_role, {
					organizationId: s.f.db.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					userId: s.f.db.userId,
					role: "viewer",
				})).toEqual({ _yay: null });
				expect(await s.f.asUser.query(api.access_control.get_current_user_workspace_permission, {
					membershipId: s.f.db.membershipId,
					permission: "content.write",
				})).toBe(false);
			} else if (change === "lifetime") {
				expect(await member.asOwner.mutation(api.organizations.remove_user_from_organization, {
					organizationId: s.f.db.organizationId,
					userIdToRemove: s.f.db.userId,
				})).toEqual({ _yay: null });
				for (let pass = 0; pass < 100; pass++) {
					const membership = await s.f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", s.f.db.membershipId));
					if (!membership) break;
					await s.f.t.mutation(internal.organizations.continue_remove_user_from_organization, {
						organizationId: s.f.db.organizationId,
						userId: s.f.db.userId,
					});
				}
				expect(await s.f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", s.f.db.membershipId))).toBeNull();
				// The next normal organization write needs its five-second wait.
				vi.setSystemTime(Date.now() + 5_000);
				expect(await member.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: s.f.db.organizationId,
					workspaceId: s.f.db.workspaceId,
					userIdToAdd: s.f.db.userId,
				})).toEqual({ _yay: null });
				const lifetime = await s.f.t.run((ctx) => ctx.db.query("organizations_membership_lifetimes")
					.withIndex("by_workspace_user", (q) => q.eq("workspaceId", s.f.db.workspaceId).eq("userId", s.f.db.userId)).unique());
				expect(lifetime).toMatchObject({ active: true });
				expect(lifetime?.lifetime).toBeGreaterThan((await stage_state(s)).cohort!.membershipLifetime);
				if (!lifetime?.membershipId) throw new Error("Expected the new membership");
				expect(await s.f.asUser.query(api.access_control.get_current_user_workspace_permission, {
					membershipId: lifetime.membershipId,
					permission: "content.write",
				})).toBe(true);
			} else if (change === "scope") {
				expect(await member.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: member.owner.membershipId, nodeId: s.targetId })).toEqual({ _yay: null });
				expect((await s.f.t.run((ctx) => ctx.db.get("files_nodes", s.targetId)))?.restrictedScopeNodeId).toBe(s.targetId);
				expect(await s.f.asUser.query(api.files_tree.get_file_node_for_membership, { membershipId: s.f.db.membershipId, fileNodeId: s.targetId })).toBeNull();
			} else {
				expect(await member.asOwner.mutation(api.files_nodes.set_node_write_policy, { membershipId: member.owner.membershipId, nodeId: s.targetId, writePolicy: { mode: "read_only" } })).toEqual({ _yay: null });
				expect((await s.f.t.run((ctx) => ctx.db.get("files_nodes", s.targetId)))?.writePolicy).toEqual({ mode: "read_only" });
			}
			const before = await stage_state(s);
			expect(await s.f.t.mutation(internal.files_move_content.advance_stage, s.args), "content stage checks current authority in its own transaction").toBeNull();
			const after = await stage_state(s);
			expect(after.content, "no stage page is added after access changes").toEqual(before.content);
			expect(after.chunks).toEqual(before.chunks);
			expect(after.plainChunks).toEqual(before.plainChunks);
			expect(after.metadata).toEqual(before.metadata);
			expect(after.cohort?.publishedAt).toBeNull();
			expect(after.cohort?.visibleView).toBe("before");
			await test_finish_pending_update_run(s.f.asUser, s.runId);
			const repairProgress = test_progress_guard();
			for (let pass = 0; pass < 1_000; pass++) {
				const cohort = await s.f.t.run((ctx) => ctx.db.get("files_move_cohorts", s.cohortId));
				if (!cohort) throw new Error("Expected the stopped cohort");
				if (cohort.phase === "complete") break;
				repairProgress(cohort, `Repair ${cohort.workPhase} step ${cohort.step}`);
				await s.f.t.action(internal.files_move_run.run, {
					cohortId: cohort._id,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					mode: "chain",
				});
			}
			expect(await s.f.t.run((ctx) => ctx.db.get("files_move_cohorts", s.cohortId))).toMatchObject({ phase: "complete", publishedAt: null, visibleView: "before" });
			for (const draft of s.drafts) {
				expect(await s.f.t.run((ctx) => ctx.db.get("files_pending_updates", draft.proposal._id))).toMatchObject({ target: draft.proposal.target, revision: draft.proposal.revision, content: draft.proposal.content });
				if (draft.proposal.target.kind !== "private") throw new Error("Expected a private draft");
				const privateNodeId = draft.proposal.target.id;
				expect(await s.f.t.run((ctx) => ctx.db.get("files_pending_nodes", privateNodeId))).toMatchObject({ state: "active" });
				expect(await s.f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").withIndex("by_privateNode", (q) => q.eq("privateNodeId", privateNodeId)).collect())).toEqual([]);
			}
		},
	);

	test("a stage failure resumes the descriptor step", async () => {
		const s = await ready_stage();
		let failed = false;
		const resumes: unknown[] = [];
		test_spy_handler(advance_stage, async (handler, ctx, args) => {
			if (!failed) {
				failed = true;
				throw new Error("Stage test failed before commit");
			}
			return await handler(ctx, args);
		});
		test_spy_handler(run, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				if (getFunctionName(mutationArgs[0]) === "files_move_cohorts:resume") resumes.push(mutationArgs[1]);
				return await runMutation(mutationArgs[0], mutationArgs[1], mutationArgs[2]);
			});
			return await handler(ctx, args);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await s.f.t.action(internal.files_move_run.run, { cohortId: s.cohortId, step: s.args.step, runGeneration: s.args.runGeneration, mode: "chain" });
		expect(failed).toBe(true);
		expect(resumes, "a stage failure resumes the descriptor step").toEqual([{
			cohortId: s.cohortId,
			step: s.descriptor.step,
			runGeneration: s.args.runGeneration,
			error: { name: "move_step_failed", message: "This Move step failed. Review it again.", cause: { name: "move_step_failed", message: "Stage test failed before commit" } },
		}]);
		await test_finish_pending_update_run(s.f.asUser, s.runId);
		expect(await s.f.t.run((ctx) => ctx.db.get("files_move_cohorts", s.cohortId))).toMatchObject({ phase: "complete", publishedAt: null, errorCode: "move_step_failed" });
	});

	test("a lost stage reply keeps its committed step", async () => {
		const s = await ready_stage();
		// Setup advanced by hand. Queue the current step through the normal worker door.
		expect(await s.f.t.mutation(internal.files_move_cohorts.handoff, {
			cohortId: s.cohortId,
			step: s.args.step,
			runGeneration: s.args.runGeneration,
		})).toBeNull();
		const before = (await stage_state(s)).cohort!;
		const activityBefore = (await s.f.t.run((ctx) => ctx.db.get("activities", s.activityId)))!;
		if (!before.runJob) throw new Error("Expected the native Move job");
		const currentStage = { ...s.args, runGeneration: before.runJob.generation };
		const owned = (await s.f.t.run((ctx) => ctx.db.system.get(before.runJob!.id)))!;
		expect(owned.args[0]).toEqual({ cohortId: s.cohortId, step: s.args.step, runGeneration: currentStage.runGeneration, mode: "chain" });
		await s.f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending" && job.scheduledTime <= Date.now() && job._id !== owned._id) await ctx.scheduler.cancel(job._id);
		});
		let lostReplies = 0;
		let committed = before;
		const resumes: unknown[] = [];
		vi.spyOn(console, "error").mockImplementation(() => {});
		test_spy_handler(run, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const name = getFunctionName(mutationArgs[0]);
				if (name === "files_move_cohorts:resume") resumes.push(mutationArgs[1]);
				const result = await runMutation(mutationArgs[0], mutationArgs[1], mutationArgs[2]);
				if (!lostReplies && name === "files_move_content:advance_stage") {
					// Lose the reply after the real transaction commits.
					committed = (await s.f.t.run((ctx) => ctx.db.get("files_move_cohorts", s.cohortId)))!;
					lostReplies++;
					throw new Error("Stage test lost the committed reply");
				}
				return result;
			});
			return await handler(ctx, args);
		});
		vi.advanceTimersByTime(0);
		await s.f.t.finishInProgressScheduledFunctions();
		expect(lostReplies).toBe(1);
		expect(committed.step).toBe(s.args.step + 1);
		expect(committed).toMatchObject({ publishedAt: null, errorCode: null });
		expect((await s.f.t.run((ctx) => ctx.db.system.get(owned._id)))?.state.kind).toBe("success");
		expect((await stage_state(s)).cohort, "a lost stage reply keeps its committed step").toEqual(committed);
		expect(resumes).toMatchObject([{ step: s.args.step, runGeneration: currentStage.runGeneration, error: { cause: { message: "Stage test lost the committed reply" } } }]);
		expect(await s.f.t.mutation(internal.files_move_content.advance_stage, currentStage)).toBeNull();
		expect((await stage_state(s)).cohort).toEqual(committed);
		vi.setSystemTime(Date.now() + 3 * 60_000);
		await s.f.t.mutation(internal.files_move_cohorts.recover, {});
		for (let pass = 0; pass < 100; pass++) {
			const job = await s.f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).find((job) => job.name === "files_move_cohorts:recover_page" && job.state.kind === "pending"));
			if (!job) break;
			await s.f.t.run((ctx) => ctx.scheduler.cancel(job._id));
			await s.f.t.mutation(internal.files_move_cohorts.recover_page, job.args[0] as FunctionArgs<typeof internal.files_move_cohorts.recover_page>);
		}
		const recovered = (await stage_state(s)).cohort!;
		expect(recovered.step).toBe(committed.step);
		expect(recovered.runJob!.generation).toBeGreaterThan(committed.runJob!.generation);
		expect(recovered.deadlineAt).toBe(committed.deadlineAt);
		expect((await s.f.t.run((ctx) => ctx.db.get("activities", s.activityId)))?.deadlineAt).toBe(activityBefore.deadlineAt);
		await finish_group(s);
	});

	test.each(["before", "after"] as const)("the time budget hands off around a heavy stage (%s)", async (edge) => {
		const s = await ready_stage();
		const before = (await stage_state(s)).cohort!;
		let elapsed = false;
		let leanCalls = 0;
		let heavyCalls = 0;
		test_spy_handler(run, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const name = getFunctionName(mutationArgs[0]);
				if (name === "files_move_cohorts:advance") leanCalls++;
				if (name === "files_move_content:advance_stage") heavyCalls++;
				const result = await runMutation(mutationArgs[0], mutationArgs[1], mutationArgs[2]);
				if (!elapsed && name === (edge === "before" ? "files_move_cohorts:advance" : "files_move_content:advance_stage")) {
					elapsed = true;
					vi.setSystemTime(Date.now() + 5_001);
				}
				return result;
			});
			return await handler(ctx, args);
		});
		await s.f.t.action(internal.files_move_run.run, { cohortId: s.cohortId, step: s.args.step, runGeneration: s.args.runGeneration, mode: "chain" });
		expect(elapsed).toBe(true);
		expect(leanCalls).toBe(1);
		expect(heavyCalls, edge === "before" ? "an expired action budget starts no content-stage RPC" : "the time handoff keeps one committed stage").toBe(edge === "before" ? 0 : 1);
		const after = (await stage_state(s)).cohort!;
		expect(after.step, "the time handoff keeps the committed stage step").toBe(s.args.step + (edge === "before" ? 0 : 1));
		expect(after.runJob!.generation).toBeGreaterThan(before.runJob!.generation);
		const successor = await s.f.t.run((ctx) => ctx.db.system.get(after.runJob!.id));
		expect(successor?.state.kind).toBe("pending");
		expect(successor?.args[0]).toEqual({ cohortId: s.cohortId, step: after.step, runGeneration: after.runJob!.generation, mode: "chain" });
		await finish_group(s);
	});

	test("the action counts lean and heavy calls in the same 128-call budget", async () => {
		const member = await member_fixture();
		const s = await ready_stage(await start_group(member.f, 32));
		// Setup advanced by hand. Queue the current step through the normal worker door.
		expect(await s.f.t.mutation(internal.files_move_cohorts.handoff, {
			cohortId: s.cohortId,
			step: s.args.step,
			runGeneration: s.args.runGeneration,
		})).toBeNull();
		const before = (await stage_state(s)).cohort!;
		if (!before.runJob) throw new Error("Expected the native Move job");
		const owned = (await s.f.t.run((ctx) => ctx.db.system.get(before.runJob!.id)))!;
		expect(owned.args[0]).toEqual({ cohortId: s.cohortId, step: s.args.step, runGeneration: before.runJob.generation, mode: "chain" });
		await s.f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending" && job.scheduledTime <= Date.now() && job._id !== owned._id) await ctx.scheduler.cancel(job._id);
		});
		let leanCalls = 0;
		let heavyCalls = 0;
		test_spy_handler(advance, async (handler, ctx, args) => {
			leanCalls++;
			return await handler(ctx, args);
		});
		test_spy_handler(advance_stage, async (handler, ctx, args) => {
			heavyCalls++;
			return await handler(ctx, args);
		});
		vi.advanceTimersByTime(0);
		await s.f.t.finishInProgressScheduledFunctions();
		expect(heavyCalls, "the budget fixture reached real heavy stages").toBeGreaterThan(0);
		expect(leanCalls + heavyCalls, "the action counts lean and heavy calls in the same 128-call budget").toBe(128);
		const after = (await stage_state(s)).cohort!;
		expect(after.phase).not.toBe("complete");
		expect(after.runJob!.generation).toBeGreaterThan(before.runJob!.generation);
		expect((await s.f.t.run((ctx) => ctx.db.system.get(owned._id)))?.state.kind).toBe("success");
		const successor = await s.f.t.run((ctx) => ctx.db.system.get(after.runJob!.id));
		expect(successor?.state.kind).toBe("pending");
		expect(successor?.args[0]).toEqual({ cohortId: s.cohortId, step: after.step, runGeneration: after.runJob!.generation, mode: "chain" });
		await finish_group(s);
	});
});
