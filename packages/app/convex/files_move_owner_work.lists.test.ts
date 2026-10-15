import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function list_ids(docs: Doc<"files_pending_list_rows">[]) {
	return docs
		.map((doc) => ({ key: doc.listKey, id: doc._id, createdAt: doc._creationTime, updatedAt: doc.updatedAt }))
		.sort((a, b) => a.key.localeCompare(b.key));
}

describe("files_move_owner_work", () => {
	test.each(
		[9, 101].flatMap((count) => (["finish", "stop_before", "stop_after"] as const).map((mode) => ({ count, mode }))),
	)("keeps all $count chat list docs through $mode", async ({ count, mode }) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folder = async (parentId: Id<"files_nodes"> | "root", name: string) => {
			const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId,
				path: name,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const sourceId = await folder("root", "source");
		const targetId = await folder("root", "target");
		const draftsId = await folder("root", "drafts");
		const nodeId = await folder(sourceId, "item");
		const home = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		expect(
			await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userIdToAdd: home.userId,
			}),
		).toEqual({ _yay: null });
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("userId", home.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected invited member");
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: home.userId });
		const threads: Id<"ai_chat_threads">[] = [];
		for (let index = 0; index < count - 1; index++) {
			vi.setSystemTime(Date.now() + 10_000);
			const thread = await asMember.mutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				clientGeneratedId: `list-${count}-${mode}-${index}`,
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			threads.push(thread._yay.threadId);
			// Use the agent's producer so each real chat adds its own list key.
			const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: home.userId,
				target: { kind: "saved", id: nodeId },
				destParent: { kind: "saved", id: draftsId },
				destName: index % 2 ? "draft-b" : "draft-a",
				threadId: thread._yay.threadId,
			});
			expect(moved._nay).toBeUndefined();
		}
		// Run overlay jobs without firing the drafts' expiry timers.
		for (let pass = 0; pass < 1000; pass++) {
			const job = await t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
					.first(),
			);
			if (!job) break;
			vi.setSystemTime(Math.max(Date.now(), job.nextAttemptAt));
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
			if (pass === 999) throw new Error("Native overlay setup did not finish");
		}
		const proposal = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", home.userId).eq("target.kind", "saved").eq("target.id", nodeId),
				)
				.unique(),
		);
		if (!proposal) throw new Error("Expected native pending proposal");
		expect(proposal.threadIds).toEqual(threads);
		const read_docs = (cohortId?: Id<"files_move_cohorts">, view?: "before" | "after") =>
			t.run((ctx) =>
				ctx.db
					.query("files_pending_list_rows")
					.withIndex("by_pendingUpdate", (q) =>
						q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", cohortId).eq("moveView.view", view),
					)
					.collect(),
			);
		const original = list_ids(await read_docs());
		expect(original, "native producers create every chat key and the all key").toHaveLength(count);
		expect(original.map((doc) => doc.key).sort()).toEqual(["all", ...threads].sort());

		const overlay = await import("../server/files-pending-overlay.ts");
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		// Yield after cohort creation, then inspect real pages with the step driver.
		const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, limitFactor) => {
			const allowed = await canJoin(ctx, limitFactor);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique();
			return allowed && !slot?.cohortId;
		});
		const started = await asOwner.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [nodeId],
			targetParentId: targetId,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		let cohortId: Id<"files_move_cohorts"> | null = null;
		const refresh = async () => {
			if (!cohortId) {
				const slot = await t.run((ctx) =>
					ctx.db
						.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
						)
						.unique(),
				);
				cohortId = slot?.cohortId ?? null;
				if (cohortId) join.mockRestore();
			}
			return cohortId ? await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId!)) : null;
		};
		const beforePages: number[] = [];
		const advance = async () => {
			const current = await refresh();
			if (current) {
				await t.action(internal.files_move_run.run, {
					cohortId: current._id,
					step: current.step,
					runGeneration: current.runJob?.generation ?? null,
					mode: "step",
				});
			} else await t.mutation(internal.files_transfer.advance, { runId });
			const next = await refresh();
			if (next) {
				const staged = (await read_docs(next._id, "before")).length;
				if (staged > (beforePages.at(-1) ?? 0)) beforePages.push(staged);
			}
		};
		for (let pass = 0; beforePages.length === 0; pass++) {
			if (pass === 1000) throw new Error("Native list staging did not start");
			await advance();
		}
		const currentCohort = (await refresh())!;
		const id = currentCohort._id;
		expect(beforePages, "the first native list page ends the Move step").toEqual([Math.min(count, 100)]);
		expect(await read_docs(id, "after"), "a native Before list page leaves After docs for a later step").toEqual([]);
		const read_list = async (view?: "before" | "after", expected = original) => {
			const current = await asMember.query(api.files_tree.get_workspace_move_view, { membershipId: membership._id });
			if (!current) throw new Error("Expected the native workspace view");
			if (view) expect(current.view).toBe(view);
			// Match the app: combine the normal stream with the visible Move stream.
			const streams = [
				{ kind: "normal" as const, generation: current.generation },
				...(current.cohortId && current.view
					? [
							{
								kind: "cohort" as const,
								cohortId: current.cohortId,
								view: current.view,
								generation: current.generation,
							},
						]
					: []),
			];
			const sourceKeys = new Set<Doc<"files_pending_list_keys">["listKey"]>();
			for (const savedStream of streams) {
				let cursor: string | null = null;
				for (let page = 0; page < 1000; page++) {
					const result: FunctionReturnType<typeof api.files_pending_list.list_files_pending_sources> =
						await asMember.query(api.files_pending_list.list_files_pending_sources, {
							membershipId: membership._id,
							savedStream,
							paginationOpts: { cursor, numItems: 20 },
						});
					for (const source of result.page) sourceKeys.add(source.listKey);
					if (result.isDone) break;
					cursor = result.continueCursor;
					if (page === 999) throw new Error("Native chat source pages did not finish");
				}
			}
			expect([...sourceKeys].sort(), "the source selector keeps every chat key").toEqual([...threads].sort());
			for (const { key } of original) {
				const docs = [];
				for (const savedStream of streams) {
					const result = await asMember.query(api.files_pending_list.list_files_pending_updates, {
						membershipId: membership._id,
						listKey: key,
						savedStream,
						paginationOpts: { cursor: null, numItems: 20 },
					});
					docs.push(...result.page);
				}
				expect(
					docs.map((doc) => doc.pendingUpdateId),
					`Pending list ${key} keeps the proposal`,
				).toEqual([proposal._id]);
				expect(docs[0]!.listRowId, `Pending list ${key} keeps the chosen ID`).toBe(
					expected.find((doc) => doc.key === key)!.id,
				);
			}
		};
		let stagedAfter: ReturnType<typeof list_ids> = [];
		if (mode === "stop_before") {
			const stagedBefore = list_ids(await read_docs(id, "before"));
			expect(
				[...stagedBefore, ...list_ids(await read_docs())].sort((a, b) => a.key.localeCompare(b.key)),
				"the partial page keeps every original list ID",
			).toEqual(original);
			await read_list("before");
			expect(await asOwner.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId })).toEqual({
				_yay: null,
			});
		} else {
			for (let pass = 0; pass < 1000; pass++) {
				if ((await refresh())!.workPhase === "publish") break;
				await advance();
				if (pass === 999) throw new Error("Native Move did not reach publication");
			}
			expect(list_ids(await read_docs(id, "before")), "staged Before keeps every original ID").toEqual(original);
			expect(await read_docs(), "staging leaves no normal list doc").toEqual([]);
			stagedAfter = list_ids(await read_docs(id, "after"));
			expect(
				stagedAfter.map((doc) => doc.key),
				"staged After keeps every chat key",
			).toEqual(original.map((doc) => doc.key));
			expect(beforePages, "the next native list page resumes the remaining docs").toEqual(
				count === 101 ? [100, 101] : [9],
			);
			await read_list("before");
			await advance();
			expect((await refresh())!.publishedAt).not.toBeNull();
			expect(list_ids(await read_docs(id, "before")), "publication keeps Before IDs until cleanup").toEqual(original);
			expect(list_ids(await read_docs(id, "after")), "publication keeps every staged After ID").toEqual(stagedAfter);
			await read_list("after", stagedAfter);
			if (mode === "stop_after") {
				expect(await asOwner.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId })).toEqual({
					_yay: null,
				});
			}
		}
		await test_finish_transfer_run(asOwner, runId);
		const final = list_ids(await read_docs());
		expect(final, "cleanup keeps exactly the chosen list IDs").toEqual(mode === "stop_before" ? original : stagedAfter);
		expect(await read_docs(id, "before")).toEqual([]);
		expect(await read_docs(id, "after")).toEqual([]);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id)),
			"the unselected proposal stays unchanged",
		).toEqual(proposal);
		await read_list(undefined, final);
		const finished = (await refresh())!;
		expect(finished.phase).toBe("complete");
		expect(finished.pendingWorkCount).toBe(0);
		expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe(
			mode === "stop_before" ? "/source/item" : "/target/item",
		);
	});
});
