import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { advance as advance_review, plan as plan_review } from "./files_pending_update_runs.ts";
import {
	fixture,
	finish_review,
	mock_review_storage,
	private_node,
	saved_text,
	stage_text,
	start_review,
} from "./files_pending_update_runs_content.setup.test.ts";
import { start_agent_transfer } from "./files_transfer.setup.test.ts";
import { test_finish_transfer_run, test_spy_handler } from "./setup.test.ts";
import * as visible_resolve from "../server/files-visible-resolve.ts";
import { files_db_load_pending_update_yjs_state_bytes, files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_saved_placement_db_get_publish_receipt } from "../server/files-saved-placement.ts";

beforeEach(mock_review_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function read_sibling(
	ctx: Pick<MutationCtx, "db">,
	proposal: Doc<"files_pending_updates">,
	view?: { cohortId: Id<"files_move_cohorts">; view: "before" | "after" },
) {
	if (proposal.target.kind !== "private") throw new Error("Expected the private sibling");
	// The fixture has one short text and one metadata key on this proposal.
	return {
		node: await ctx.db.get("files_pending_nodes", proposal.target.id),
		proposal: await ctx.db.get("files_pending_updates", proposal._id),
		place: await ctx.db
			.query("files_pending_places")
			.withIndex("by_pendingUpdate", (q) =>
				q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", view?.cohortId).eq("moveView.view", view?.view),
			)
			.unique(),
		plain: await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", view?.cohortId).eq("moveView.view", view?.view),
			)
			.collect(),
		metadata: await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_pendingUpdate_fieldPath", (q) =>
				q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", view?.cohortId).eq("moveView.view", view?.view),
			)
			.collect(),
	};
}

function side_payload(rows: Array<Doc<"files_plain_text_chunks"> | Doc<"files_metadata_docs">>, path?: string) {
	// Save updates scope paths while keeping the same pending content and metadata values.
	return rows.map(({ _id: _id, _creationTime: _created, moveView: _view, ...row }) =>
		path === undefined ? row : { ...row, path, ...("treePath" in row ? { treePath: path } : {}) },
	);
}

async function pending_text(f: Awaited<ReturnType<typeof fixture>>, proposal: Doc<"files_pending_updates">) {
	if (!proposal.content) throw new Error("Expected the pending text");
	const stateId = proposal.content.unstagedStateId;
	return await f.t.run(async (ctx) => {
		const state = await ctx.db.get("files_pending_update_yjs_states", stateId);
		if (!state) throw new Error("Expected the pending text state");
		const bytes = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc: state });
		if (bytes._nay) throw new Error(bytes._nay.message);
		const doc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(bytes._yay));
		const text = files_yjs_doc_get_text({ yjsDoc: doc, rootKind: "plain_text" });
		if (text._nay) throw new Error(text._nay.message);
		return text._yay;
	});
}

describe("Move owner parent resolution", () => {
	test("a partial Save skips the unused saved owner path", async () => {
		const f = await fixture();
		const parent = await private_node({ f, path: "/parent" });
		const initial = await private_node({ f, path: "/parent/leaf.txt", text: "initial\n" });
		const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: f.db.membershipId,
			target: initial.target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const partial = await stage_text({
			f,
			target: initial.target,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: initial._id,
			text: "selected\n",
			unstagedText: "remainder\n",
		});
		let savedResolutions = 0;
		const createReader = visible_resolve.files_visible_resolve_db_create;
		vi.spyOn(visible_resolve, "files_visible_resolve_db_create").mockImplementation((db, scope) => {
			const reader = createReader(db, scope);
			const resolve = reader.resolve;
			reader.resolve = async (target) => {
				if (scope.fixedView?.view === "after" && target.kind === "saved") savedResolutions++;
				return await resolve(target);
			};
			return reader;
		});
		const runId = await start_review({ f, proposals: [parent, partial], selected: "staged" });
		const result = await finish_review({ f, runId });
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, failed: 0 } });
		expect(savedResolutions, "a content-only partial Save does not resolve its saved ancestor chain").toBe(0);
		const remainder = await f.t.run((ctx) => ctx.db.get("files_pending_updates", partial._id));
		if (remainder?.target.kind !== "saved") throw new Error("Expected the saved remainder target");
		expect(await saved_text(f, remainder.target.id)).toBe("selected\n");
		expect(await pending_text(f, remainder)).toBe("remainder\n");
	});

	test(
		"a deep private partial Save avoids an unused saved ancestor walk",
		{ tags: ["full-size"], timeout: 600_000 },
		async () => {
			const f = await fixture();
			const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
				membershipId: f.db.membershipId,
				clientGeneratedId: "deep-private-save",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
				userId: f.scope.userId,
				membershipId: f.db.membershipId,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const agentSource = {
				...f.scope,
				membershipId: f.db.membershipId,
				threadId: thread._yay.threadId,
				membershipLifetime: captured._yay.membershipLifetime,
			};
			const groups: Array<{
				root: Id<"files_pending_nodes">;
				leaf: Id<"files_pending_nodes">;
				leafPath: string;
			}> = [];
			let partial: Doc<"files_pending_updates"> | undefined;
			let sibling: Doc<"files_pending_updates"> | undefined;
			// Each create stays inside the normal 32-new-node limit. Move composes the subtrees later.
			for (let index = 0; index < 8; index++) {
				const name = `chain-${index}`;
				const leafPath = `/${name}/${Array.from({ length: 31 }, (_, child) =>
					index === 6 && child === 30 ? "leaf.txt" : "a",
				).join("/")}`;
				const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
					...f.scope,
					threadId: thread._yay.threadId,
					agentSource,
					path: leafPath,
					kind: index === 6 ? "file" : "folder",
				});
				if (created._nay || created._yay.target.kind !== "private")
					throw new Error(created._nay?.message ?? "Expected the private chain leaf");
				const root = await f.t.run((ctx) =>
					ctx.db
						.query("files_pending_nodes")
						.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
							q
								.eq("organizationId", f.scope.organizationId)
								.eq("workspaceId", f.scope.workspaceId)
								.eq("userId", f.scope.userId)
								.eq("parent.kind", "root")
								.eq("parent.id", undefined)
								.eq("state", "active")
								.eq("name", name),
						)
						.unique(),
				);
				if (!root) throw new Error("Expected the private chain root");
				groups.push({ root: root._id, leaf: created._yay.target.id, leafPath });
				if (index === 6) {
					if (!created._yay.operationBatchId || !created._yay.pendingUpdateId)
						throw new Error("Expected the private text batch");
					const initial = await stage_text({
						f,
						target: created._yay.target,
						operationBatchId: created._yay.operationBatchId,
						pendingUpdateId: created._yay.pendingUpdateId,
						text: "initial\n",
					});
					const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
						membershipId: f.db.membershipId,
						target: initial.target,
					});
					if (batch._nay) throw new Error(batch._nay.message);
					partial = await stage_text({
						f,
						target: initial.target,
						operationBatchId: batch._yay.operationBatchId,
						pendingUpdateId: initial._id,
						text: "selected\n",
						unstagedText: "remainder\n",
					});
					const siblingPath = `${leafPath.slice(0, leafPath.lastIndexOf("/"))}/sibling.txt`;
					const createdSibling = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
						...f.scope,
						threadId: thread._yay.threadId,
						agentSource,
						path: siblingPath,
						kind: "file",
					});
					if (createdSibling._nay || !createdSibling._yay.operationBatchId || !createdSibling._yay.pendingUpdateId)
						throw new Error(createdSibling._nay?.message ?? "Expected the private sibling batch");
					const text = await stage_text({
						f,
						target: createdSibling._yay.target,
						operationBatchId: createdSibling._yay.operationBatchId,
						pendingUpdateId: createdSibling._yay.pendingUpdateId,
						text: "sibling stays pending\n",
					});
					expect(
						(
							await f.t.mutation(internal.files_metadata.update_entries_by_path, {
								...f.scope,
								agentSource,
								path: siblingPath,
								set: [{ key: "marker", value: "sibling" }],
								remove: [],
							})
						)._nay,
					).toBeUndefined();
					sibling = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", text._id))) ?? undefined;
				}
			}
			if (!partial) throw new Error("Expected the partial leaf proposal");
			if (!sibling || sibling.target.kind !== "private") throw new Error("Expected the unselected private sibling");
			const partialProposal = partial;
			const siblingProposal = sibling;
			const siblingId = sibling.target.id;
			const move = async (sourceIndex: number, destinationIndex: number) => {
				const source = groups[sourceIndex]!;
				const destination = groups[destinationIndex]!;
				const started = await start_agent_transfer(f.t, {
					membershipId: f.db.membershipId,
					threadId: thread._yay.threadId,
					sourceWorkspace: "current",
					destinationWorkspace: "current",
					requestId: `compose-${sourceIndex}-${destinationIndex}`,
					kind: "move",
					sources: [{ kind: "private", id: source.root }],
					targetParent: { kind: "private", id: destination.leaf },
					targetPath: destination.leafPath,
					targetName: null,
					missingParentNames: [],
					conflictPolicy: { file: "error", folder: "error" },
				});
				if (started._nay) throw new Error(started._nay.message);
				await test_finish_transfer_run(f.asUser, started._yay.runId);
				const result = await f.asUser.query(api.files_transfer_queries.get, {
					membershipId: f.db.membershipId,
					runId: started._yay.runId,
				});
				expect(result?.activity, JSON.stringify({ sourceIndex, destinationIndex, result })).toMatchObject({
					status: "succeeded",
					progress: { completed: 1, failed: 0 },
				});
				source.leafPath = `${destination.leafPath}${source.leafPath}`;
			};
			// Each Move uses a fresh 32-node destination. The final chain has 255 folders and one file.
			await move(6, 5);
			await move(5, 4);
			await move(4, 3);
			await move(3, 2);
			await move(2, 1);
			await move(1, 0);
			await move(0, 7);
			const original = await f.t.run((ctx) =>
				// This fixture creates 255 folders, the selected file and one unselected sibling.
				ctx.db
					.query("files_pending_nodes")
					.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
					.collect(),
			);
			expect(original).toHaveLength(257);
			const byId = new Map(original.map((node) => [node._id, node]));
			const pathOf = (node: Doc<"files_pending_nodes">) => {
				const names = [node.name];
				let parent = node.parent;
				while (parent.kind === "private") {
					const ancestor = byId.get(parent.id)!;
					names.unshift(ancestor.name);
					parent = ancestor.parent;
				}
				expect(parent.kind).toBe("root");
				return `/${names.join("/")}`;
			};
			const leafPath = pathOf(byId.get(groups[6]!.leaf)!);
			expect(leafPath.split("/").length - 1, "the real producers built all 255 private parents").toBe(256);
			const siblingPath = pathOf(byId.get(siblingId)!);
			const siblingBefore = await f.t.run((ctx) => read_sibling(ctx, siblingProposal));
			expect(await pending_text(f, siblingProposal)).toBe("sibling stays pending\n");
			expect(siblingBefore.place).toMatchObject({
				parent: byId.get(siblingId)!.parent,
				ownerTreePath: siblingPath,
				accessNodeId: null,
			});
			expect(siblingBefore.plain.length).toBeGreaterThan(0);
			expect(siblingBefore.metadata.map((row) => [row.docKind, row.fieldPath, row.stringValue])).toEqual([
				["field", "metadata.marker", undefined],
				["value", "metadata.marker", "sibling"],
			]);
			const proposals = await f.t.run(async (ctx) => {
				const rows = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", f.scope.organizationId)
							.eq("workspaceId", f.scope.workspaceId)
							.eq("userId", f.scope.userId),
					)
					.collect();
				return rows
					.filter((row) => row._id !== siblingProposal._id)
					.sort(
						(a, b) =>
							pathOf(byId.get(a.target.id as Id<"files_pending_nodes">)!).length -
							pathOf(byId.get(b.target.id as Id<"files_pending_nodes">)!).length,
					);
			});
			expect(proposals).toHaveLength(256);
			console.info("deep private producer setup complete");
			const costs: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>[] = [];
			let planned = false;
			let ownersStarted = false;
			let ownersFinished = false;
			let checkedStaging = false;
			let stagedSibling: Awaited<ReturnType<typeof read_sibling>> | undefined;
			test_spy_handler(advance_cohort, async (handler, ctx, args) => {
				const call = args as { cohortId: Id<"files_move_cohorts">; step: number };
				const entry = await ctx.db.get("files_move_cohorts", call.cohortId);
				if (!planned) {
					console.info("deep private Review plan complete");
					planned = true;
				}
				if (entry?.workPhase === "owners_stage" && !ownersStarted) {
					console.info("deep private owners_stage entered", call.step);
					ownersStarted = true;
				} else if (ownersStarted && entry?.workPhase !== "owners_stage" && !ownersFinished) {
					console.info("deep private owners_stage left", call.step);
					ownersFinished = true;
				}
				try {
					const result = await handler(ctx, args);
					const current = await ctx.db.get("files_move_cohorts", call.cohortId);
					if (
						!checkedStaging &&
						current?.publishedAt === null &&
						(current.phase === "validating" || current.phase === "ready")
					) {
						const before = await read_sibling(ctx, siblingProposal, { cohortId: call.cohortId, view: "before" });
						stagedSibling = await read_sibling(ctx, siblingProposal, { cohortId: call.cohortId, view: "after" });
						const parent = siblingBefore.node!.parent;
						if (parent.kind !== "private") throw new Error("Expected the private sibling parent");
						const receipt = await files_saved_placement_db_get_publish_receipt(
							ctx.db,
							{
								...f.scope,
								privateNodeId: parent.id,
							},
							{ cohortId: call.cohortId, view: "after" },
						);
						expect.soft(receipt, "the selected parent has its exact After receipt").not.toBeNull();
						expect
							.soft(before.place)
							.toEqual({ ...siblingBefore.place, moveView: { cohortId: call.cohortId, view: "before" } });
						expect.soft(before.plain.map(({ moveView: _view, ...row }) => row)).toEqual(siblingBefore.plain);
						expect.soft(before.metadata.map(({ moveView: _view, ...row }) => row)).toEqual(siblingBefore.metadata);
						expect
							.soft(stagedSibling.place, "the unselected sibling has its After saved parent and access ID")
							.toMatchObject({
								target: siblingProposal.target,
								parent: { kind: "saved", id: receipt?.savedNodeId },
								ownerTreePath: siblingPath,
								accessNodeId: receipt?.savedNodeId,
								isVisible: true,
								isPathless: false,
								destinationAccessNodeIds: [],
							});
						expect.soft(side_payload(stagedSibling.plain)).toEqual(side_payload(siblingBefore.plain, siblingPath));
						expect
							.soft(side_payload(stagedSibling.metadata))
							.toEqual(side_payload(siblingBefore.metadata, siblingPath));
						checkedStaging = true;
					}
					costs.push(await ctx.meta.getTransactionMetrics());
					if (costs.length % 500 === 0) console.info("deep private Save worker step", call.step);
					return result;
				} catch (error) {
					console.info(
						"deep private failed worker cost",
						call.step,
						JSON.stringify(await ctx.meta.getTransactionMetrics()),
					);
					throw error;
				}
			});
			test_spy_handler(advance_review, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				costs.push(await ctx.meta.getTransactionMetrics());
				return result;
			});
			let planningPasses = 0;
			test_spy_handler(plan_review, async (handler, ctx, args) => {
				if (planningPasses === 0) console.info("deep private Review plan entered");
				if (++planningPasses % 100 === 0) console.info("deep private Review planning passes", planningPasses);
				return await handler(ctx, args);
			});
			let savedResolutions = 0;
			const createReader = visible_resolve.files_visible_resolve_db_create;
			vi.spyOn(visible_resolve, "files_visible_resolve_db_create").mockImplementation((db, scope) => {
				const reader = createReader(db, scope);
				const resolve = reader.resolve;
				reader.resolve = async (target) => {
					if (scope.fixedView?.view === "after" && target.kind === "saved") savedResolutions++;
					return await resolve(target);
				};
				return reader;
			});
			const items = proposals.map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content?.stagedStateId ?? null,
			}));
			// One-item intake pages keep this deep fixture within the current Review capture limit.
			const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
				membershipId: f.db.membershipId,
				requestId: "deep-private-partial-save",
				kind: "accept",
				expectedItemCount: items.length,
				items: items.slice(0, 1),
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			for (let offset = 1; offset < items.length; offset++)
				expect(
					await f.asUser.mutation(api.files_pending_update_runs.append_items, {
						membershipId: f.db.membershipId,
						runId,
						offset,
						items: items.slice(offset, offset + 1),
					}),
				).toEqual({ _yay: null });
			expect(
				await f.asUser.mutation(api.files_pending_update_runs.seal, {
					membershipId: f.db.membershipId,
					runId,
				}),
			).toEqual({ _yay: null });
			console.info("deep private Review intake complete");
			const result = await finish_review({ f, runId });
			console.info(
				"deep private partial Save budget",
				JSON.stringify(
					Object.fromEntries(
						Object.keys(costs[0] ?? {}).map((name) => [
							name,
							Math.max(...costs.map((cost) => cost[name as keyof typeof cost].used)),
						]),
					),
				),
			);
			expect(savedResolutions, "a content-only partial Save does not resolve its saved ancestor chain").toBe(0);
			expect(result?.activity, "the full private Save finishes after owner staging").toMatchObject({
				status: "succeeded",
				progress: { completed: 256, blocked: 0, failed: 0 },
			});
			expect(checkedStaging, "both sibling views were checked before publication").toBe(true);
			expect(costs.length).toBeGreaterThan(0);
			for (const cost of costs) {
				expect(Object.keys(cost)).toHaveLength(7);
				for (const [name, metric] of Object.entries(cost))
					expect(metric.used, `${name} includes the final wrapper flush and leaves 25% free`).toBeLessThan(
						(metric.used + metric.remaining) * 0.75,
					);
			}
			const state = await f.t.run(async (ctx) => ({
				cohort: await ctx.db
					.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
					.unique(),
				receipts: await ctx.db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
					.collect(),
				slot: await ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
					)
					.unique(),
				remainder: await ctx.db.get("files_pending_updates", partialProposal._id),
			}));
			expect(state.cohort).toMatchObject({ phase: "complete", publishedAt: expect.any(Number) });
			expect(state.slot?.cohortId).toBeNull();
			expect(state.receipts).toHaveLength(256);
			expect(state.receipts.some((receipt) => receipt.privateNodeId === siblingProposal.target.id)).toBe(false);
			for (const receipt of state.receipts) {
				const before = byId.get(receipt.privateNodeId)!;
				const saved = await f.t.run((ctx) => ctx.db.get("files_nodes", receipt.savedNodeId));
				expect(saved).toMatchObject({
					_id: receipt.savedNodeId,
					name: before.name,
					path: pathOf(before),
					publishedFromPrivateNodeId: before._id,
				});
				expect(saved?.moveCohortId).toBeUndefined();
				expect(receipt.moveView).toBeUndefined();
			}
			const leafReceipt = state.receipts.find((receipt) => receipt.privateNodeId === groups[6]!.leaf)!;
			expect(state.remainder).toMatchObject({
				target: { kind: "saved", id: leafReceipt.savedNodeId },
				revision: partialProposal.revision + 1,
			});
			expect(await saved_text(f, leafReceipt.savedNodeId)).toBe("selected\n");
			if (!state.remainder?.content) throw new Error("Expected the exact pending remainder");
			expect(await pending_text(f, state.remainder)).toBe("remainder\n");
			const siblingAfter = await f.t.run((ctx) => read_sibling(ctx, siblingProposal));
			expect(siblingAfter.node).toMatchObject({
				_id: siblingProposal.target.id,
				state: "active",
				parent: siblingBefore.node!.parent,
			});
			expect(siblingAfter.proposal).toMatchObject({
				_id: siblingProposal._id,
				target: siblingProposal.target,
				revision: siblingProposal.revision,
				content: siblingProposal.content,
				createIntent: siblingProposal.createIntent,
			});
			expect(siblingAfter.proposal?.moveCohortId).toBeUndefined();
			expect(siblingAfter.place).toMatchObject({
				_id: stagedSibling!.place!._id,
				parent: stagedSibling!.place!.parent,
				ownerTreePath: siblingPath,
				accessNodeId: stagedSibling!.place!.accessNodeId,
				isVisible: true,
				isPathless: false,
				destinationAccessNodeIds: [],
			});
			expect(siblingAfter.place?.moveView).toBeUndefined();
			expect(side_payload(siblingAfter.plain)).toEqual(side_payload(siblingBefore.plain, siblingPath));
			expect(side_payload(siblingAfter.metadata)).toEqual(side_payload(siblingBefore.metadata, siblingPath));
			expect(await pending_text(f, siblingAfter.proposal!)).toBe("sibling stays pending\n");
			if (!state.cohort) throw new Error("Expected the completed Save cohort");
			const cleanup = await f.t.run(async (ctx) => ({
				owners: await ctx.db
					.query("files_move_owner_work")
					.withIndex("by_cohort_order", (q) => q.eq("cohortId", state.cohort!._id))
					.collect(),
				sources: await ctx.db
					.query("files_move_source_reservations")
					.withIndex("by_cohort", (q) => q.eq("cohortId", state.cohort!._id))
					.collect(),
				claims: await ctx.db
					.query("files_move_slot_claims")
					.withIndex("by_cohort", (q) => q.eq("cohortId", state.cohort!._id))
					.collect(),
			}));
			// The saved root's slot also needs owner work while its private draft uses that name.
			const rootReceipt = state.receipts.find((receipt) => receipt.privateNodeId === groups[7]!.root)!;
			expect(cleanup.owners.map((owner) => [owner.userId, owner.target.kind, owner.target.id]).sort()).toEqual(
				[
					...original.map((node) => [f.scope.userId, "private", node._id]),
					[f.scope.userId, "saved", rootReceipt.savedNodeId],
				].sort(),
			);
			expect(cleanup.owners.every((owner) => owner.status === "materialized")).toBe(true);
			expect(cleanup.sources).toEqual([]);
			expect(cleanup.claims).toEqual([]);
		},
	);

	test.each(["before", "after"] as const)(
		"Stop %s publication preserves an unselected private sibling",
		async (timing) => {
			const f = await fixture();
			const leaf = await private_node({ f, path: "/parent/leaf.txt", text: "selected\n" });
			const createdSibling = await private_node({ f, path: "/parent/sibling.txt", text: "sibling stays pending\n" });
			expect(
				(
					await f.t.mutation(internal.files_metadata.update_entries_by_path, {
						...f.scope,
						path: "/parent/sibling.txt",
						set: [{ key: "marker", value: "sibling" }],
						remove: [],
					})
				)._nay,
			).toBeUndefined();
			const { parentProposal, sibling } = await f.t.run(async (ctx) => {
				if (leaf.target.kind !== "private") throw new Error("Expected the selected private leaf");
				const leafNode = await ctx.db.get("files_pending_nodes", leaf.target.id);
				if (leafNode?.parent.kind !== "private") throw new Error("Expected the selected private parent");
				const parentId = leafNode.parent.id;
				return {
					parentProposal: await ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", f.scope.userId).eq("target.kind", "private").eq("target.id", parentId),
						)
						.unique(),
					sibling: await ctx.db.get("files_pending_updates", createdSibling._id),
				};
			});
			if (!parentProposal || !sibling || parentProposal.target.kind !== "private" || sibling.target.kind !== "private")
				throw new Error("Expected the two private proposals");
			const parentPrivateId = parentProposal.target.id;
			const original = await f.t.run((ctx) => read_sibling(ctx, sibling));
			expect(original.plain.length).toBeGreaterThan(0);
			expect(original.metadata).toHaveLength(2);
			const runId = await start_review({ f, proposals: [parentProposal, leaf] });
			let stopped: Doc<"files_move_cohorts"> | undefined;
			for (let pass = 0; pass < 1000; pass++) {
				const cohort = await f.t.run((ctx) =>
					ctx.db
						.query("files_move_cohorts")
						.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
						.unique(),
				);
				if (!cohort) {
					await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
					continue;
				}
				expect(cohort.errorCode).toBeNull();
				const ready =
					timing === "before"
						? cohort.publishedAt === null && (cohort.phase === "validating" || cohort.phase === "ready")
						: cohort.publishedAt !== null;
				if (ready) {
					stopped = cohort;
					break;
				}
				await f.t.action(internal.files_move_run.run, {
					cohortId: cohort._id,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					mode: "step",
				});
			}
			if (!stopped) throw new Error("The real worker did not reach the Stop point");
			expect(stopped.phase, "Stop runs before physical repair finishes").not.toBe("complete");
			const receipt = await f.t.run((ctx) =>
				files_saved_placement_db_get_publish_receipt(
					ctx.db,
					{
						...f.scope,
						privateNodeId: parentPrivateId,
					},
					{ cohortId: stopped!._id, view: "after" },
				),
			);
			if (!receipt) throw new Error("Expected the selected parent's After receipt");
			const before = await f.t.run((ctx) => read_sibling(ctx, sibling, { cohortId: stopped!._id, view: "before" }));
			const after = await f.t.run((ctx) => read_sibling(ctx, sibling, { cohortId: stopped!._id, view: "after" }));
			expect(before.place).toEqual({ ...original.place, moveView: { cohortId: stopped._id, view: "before" } });
			expect(before.plain.map(({ moveView: _view, ...row }) => row)).toEqual(original.plain);
			expect(before.metadata.map(({ moveView: _view, ...row }) => row)).toEqual(original.metadata);
			expect(after.place, "the unselected sibling has its After saved parent and access ID").toMatchObject({
				target: sibling.target,
				parent: { kind: "saved", id: receipt.savedNodeId },
				ownerTreePath: "/parent/sibling.txt",
				accessNodeId: receipt.savedNodeId,
				isVisible: true,
				isPathless: false,
				destinationAccessNodeIds: [],
			});
			expect(side_payload(after.plain)).toEqual(side_payload(original.plain));
			expect(side_payload(after.metadata)).toEqual(side_payload(original.metadata));
			expect(
				await f.asUser.query(api.files_visible.get_path, { membershipId: f.db.membershipId, target: sibling.target }),
			).toBe("/parent/sibling.txt");
			const activityId = await f.t.run(
				async (ctx) =>
					(await ctx.db
						.query("activities")
						.withIndex("by_source_id", (q) => q.eq("source.id", runId))
						.unique())!._id,
			);
			expect(
				await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId }),
			).toEqual({ _yay: null });
			let finished: Doc<"files_move_cohorts"> | undefined;
			for (let pass = 0; pass < 1000; pass++) {
				const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", stopped!._id)))!;
				if (cohort.phase === "complete") {
					finished = cohort;
					break;
				}
				await f.t.action(internal.files_move_run.run, {
					cohortId: cohort._id,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					mode: "chain",
				});
			}
			if (!finished) throw new Error("Stop repair did not finish");
			expect(finished.publishedAt === null, "Stop keeps the already selected saved view").toBe(timing === "before");
			await f.t.mutation(internal.files_move_cohorts.wake_owner_jobs, { cohortId: finished._id });
			await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: finished._id });
			await finish_review({ f, runId });
			const final = await f.t.run((ctx) => read_sibling(ctx, sibling));
			expect(final.node).toMatchObject({ _id: sibling.target.id, state: "active", parent: original.node!.parent });
			expect(final.proposal).toMatchObject({
				_id: sibling._id,
				target: sibling.target,
				revision: sibling.revision,
				content: sibling.content,
				createIntent: sibling.createIntent,
			});
			expect(final.proposal?.moveCohortId).toBeUndefined();
			if (timing === "before") {
				expect(final.place).toEqual(original.place);
				expect(final.plain).toEqual(original.plain);
				expect(final.metadata).toEqual(original.metadata);
			} else {
				expect(final.place).toEqual({ ...after.place, moveView: undefined });
				expect(final.plain.map(({ moveView: _view, ...row }) => row)).toEqual(
					after.plain.map(({ moveView: _view, ...row }) => row),
				);
				expect(final.metadata.map(({ moveView: _view, ...row }) => row)).toEqual(
					after.metadata.map(({ moveView: _view, ...row }) => row),
				);
			}
			expect(await pending_text(f, final.proposal!)).toBe("sibling stays pending\n");
			expect(
				await f.asUser.query(api.files_visible.get_path, { membershipId: f.db.membershipId, target: sibling.target }),
			).toBe("/parent/sibling.txt");
			const cleanup = await f.t.run(async (ctx) => ({
				receipts: await ctx.db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
					.collect(),
				sources: await ctx.db
					.query("files_move_source_reservations")
					.withIndex("by_cohort", (q) => q.eq("cohortId", finished!._id))
					.collect(),
				claims: await ctx.db
					.query("files_move_slot_claims")
					.withIndex("by_cohort", (q) => q.eq("cohortId", finished!._id))
					.collect(),
				slot: await ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
					)
					.unique(),
			}));
			expect(cleanup.receipts).toHaveLength(timing === "before" ? 0 : 2);
			expect(cleanup.receipts.some((row) => row.privateNodeId === sibling.target.id)).toBe(false);
			expect(cleanup.sources).toEqual([]);
			expect(cleanup.claims).toEqual([]);
			expect(cleanup.slot?.cohortId).toBeNull();
		},
		60_000,
	);
});
