import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { api, internal } from "./_generated/api.js";
import { advance as advance_cohort, files_move_cohorts_db_advance } from "./files_move_cohorts.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { upsert_file_pending_update_public_for_test } from "./files_pending_updates.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_db_get_review_state,
	test_finish_pending_update_run,
	test_finish_saved_scope_jobs,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
	test_spy_handler,
} from "./setup.test.ts";
import { files_content_heads_db_wrap } from "../server/files-content-heads.ts";
import { files_move_reservations_db_wrap } from "../server/files-move-reservations.ts";
import {
	files_saved_content_collect,
	files_saved_content_db_plain_text_chunks,
	files_saved_content_db_text_chunks,
} from "../server/files-saved-content.ts";
import { files_saved_content_db_get_head } from "../server/files-saved-content-head.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_node_view,
} from "../server/files-saved-placement.ts";

const text = "---\ntopic: ownership\nstatus: saved\n---\nContent stays with this file.\n";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function read_content(ctx: QueryCtx, nodeId: Id<"files_nodes">) {
	const node = await files_saved_placement_db_get_node(ctx.db, nodeId);
	if (!node) throw new Error("Expected the saved file");
	const scope = { organizationId: node.organizationId, workspaceId: node.workspaceId, nodeId };
	const head = await files_saved_content_db_get_head(ctx.db, node);
	if (!head) throw new Error("Expected the saved content head");
	const exact = await files_saved_content_collect(files_saved_content_db_text_chunks(ctx.db, scope));
	const plain = await files_saved_content_collect(files_saved_content_db_plain_text_chunks(ctx.db, scope));
	const view = await files_saved_placement_db_get_node_view(ctx.db, nodeId);
	const metadata = (
		await Promise.all(
			(view ? [undefined, view] : [undefined]).map((tag) =>
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_contentHead_view_fieldPath", (q) =>
						q.eq("contentHeadId", head._id).eq("moveView.cohortId", tag?.cohortId).eq("moveView.view", tag?.view),
					)
					.collect(),
			),
		)
	).flat();
	const copies = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_contentHead_fieldPath", (q) => q.eq("contentHeadId", head._id))
		.collect();
	return {
		node,
		headId: head._id,
		view,
		text: exact.map((row) => row.textChunk).join(""),
		exactIds: exact.map((row) => row._id),
		plain: plain.map((row) => ({ index: row.chunkIndex, text: row.plainTextChunk, view: row.moveView })),
		fields: metadata
			.filter((row) => row.docKind === "field")
			.map((row) => row.fieldPath)
			.sort(),
		values: metadata
			.filter((row) => row.docKind === "value")
			.map((row) => [row.fieldPath, row.stringValue])
			.sort(),
		hasAfterCopy: copies.some((row) => row.moveView?.view === "after"),
	};
}

async function ready_content_review() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/note.md",
		textContent: text,
	});
	const accepted = text.replace("status: saved", "status: accepted");
	expect(
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: db.membershipId,
			nodeId,
			stagedMarkdown: accepted,
			unstagedMarkdown: accepted,
		}),
	).toHaveProperty("_yay");
	const proposal = (await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique(),
	))!;
	vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [
			{
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content!.stagedStateId,
			},
		],
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	for (let pass = 0; pass < 100; pass++) {
		const state = await t.run((ctx) => test_db_get_review_state(ctx, runId));
		if (state.job) {
			vi.setSystemTime(Math.max(Date.now(), state.job.nextAttemptAt));
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind: state.job.kind,
				key: state.job.key,
				nextAttemptAt: state.job.nextAttemptAt,
			});
		} else if (state.run.step === "planning")
			await t.action(internal.files_pending_update_runs.plan, { runId, fence: state.run.fence });
		else break;
		if (pass === 99) throw new Error("Review planning did not finish");
	}
	await t.mutation(internal.files_pending_update_runs.advance, { runId });
	for (let pass = 0; pass < 100; pass++) {
		const cohort = (await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
				.first(),
		))!;
		const args = {
			cohortId: cohort._id,
			step: cohort.step,
			runGeneration: cohort.runJob?.generation ?? null,
			join: false,
		};
		if (cohort.phase === "ready") {
			const content = (await t.run((ctx) =>
				ctx.db
					.query("files_move_cohort_content")
					.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", nodeId))
					.unique(),
			))!;
			expect(content.afterHeadId).not.toBe(content.beforeHeadId);
			return { t, db, asUser, nodeId, runId, args, content, accepted };
		}
		await t.action(internal.files_move_run.run, {
			cohortId: args.cohortId,
			step: args.step,
			runGeneration: args.runGeneration,
			mode: "step",
		});
	}
	throw new Error("Review did not reach publication");
}

// Insert and remove one field to inspect the owner chosen by this wrapper.
async function probe_owner(
	ctx: MutationCtx,
	nodeId: Id<"files_nodes">,
	moveView?: { cohortId: Id<"files_move_cohorts">; view: "before" | "after" },
) {
	const node = (await ctx.db.get("files_nodes", nodeId))!;
	const id = await ctx.db.insert("files_metadata_docs", {
		organizationId: node.organizationId,
		workspaceId: node.workspaceId,
		sourceKind: "committed",
		fileNodeId: nodeId,
		path: node.path,
		treePath: node.treePath,
		restrictedScopeNodeId: node.restrictedScopeNodeId,
		fieldPath: "frontmatter.cache_probe",
		docKind: "field",
		parentId: node.parentId,
		moveView,
	});
	const doc = (await ctx.db.get("files_metadata_docs", id))!;
	if (doc.sourceKind !== "committed") throw new Error("Expected saved metadata");
	await ctx.db.delete("files_metadata_docs", id);
	return doc.contentHeadId;
}

test.each(["direct", "in-flight direct", "child", "in-flight child"] as const)(
	"content owner cache follows native Review publication: %s",
	async (mode) => {
		const f = await ready_content_review();
		await f.t.run(async (raw) => {
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const runMutation: MutationCtx["runMutation"] = async (mutation, ...args) => {
				if (mode === "in-flight child") {
					entered.resolve();
					await resume.promise;
				}
				return await raw.runMutation(mutation, ...args);
			};
			const isPublication = (args: unknown[]) =>
				args[0] === "files_move_cohorts" && args[2] !== null && typeof args[2] === "object" && "publishedAt" in args[2];
			const delayedDb = new Proxy(raw.db, {
				get(target, property) {
					if (property === "patch")
						return async (...args: unknown[]) => {
							if (mode === "in-flight direct" && isPublication(args)) {
								entered.resolve();
								await resume.promise;
							}
							const patch = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
							return await Reflect.apply(patch, target, args);
						};
					const value: unknown = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const writes = files_content_heads_db_wrap({ ...raw, db: delayedDb, runMutation });
			const ctx = { ...raw, ...writes };
			for (const view of ["before", "after"] as const)
				expect(
					await probe_owner(ctx, f.nodeId, { cohortId: f.args.cohortId, view }),
					"explicit Review sides keep separate owners",
				).toBe(view === "before" ? f.content.beforeHeadId : f.content.afterHeadId);
			expect(await probe_owner(ctx, f.nodeId)).toBe(f.content.beforeHeadId);
			if (mode === "direct" || mode === "in-flight direct") {
				const inspected = {
					...ctx,
					db: new Proxy(ctx.db, {
						get(target, property) {
							if (property === "patch")
								return async (...args: unknown[]) => {
									const patch = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
									const write = Reflect.apply(patch, target, args);
									if (mode === "in-flight direct" && isPublication(args)) {
										await entered.promise;
										expect(await probe_owner(ctx, f.nodeId)).toBe(f.content.beforeHeadId);
										resume.resolve();
										await write;
										expect(
											await probe_owner(ctx, f.nodeId),
											"a lookup started during publication does not survive the write",
										).toBe(f.content.afterHeadId);
									} else await write;
								};
							const value: unknown = Reflect.get(target, property);
							return typeof value === "function" ? value.bind(target) : value;
						},
					}),
				};
				const guarded = { ...inspected, ...files_move_reservations_db_wrap(inspected) };
				const wrapped = { ...guarded, ...overlay.files_pending_overlay_db_wrap(guarded) };
				await files_move_cohorts_db_advance(wrapped, f.args);
				await overlay.files_pending_overlay_db_flush(wrapped);
			} else {
				const publish = ctx.runMutation(internal.files_move_cohorts.advance, f.args);
				if (mode === "in-flight child") {
					await entered.promise;
					expect(await probe_owner(ctx, f.nodeId)).toBe(f.content.beforeHeadId);
					resume.resolve();
				}
				await publish;
			}
			expect(await probe_owner(ctx, f.nodeId), "later fields use the published content head").toBe(
				f.content.afterHeadId,
			);
			await writes.flush();
		});
		await test_finish_pending_update_run(f.asUser, f.runId, { stepwise: true });
		expect((await f.t.run((ctx) => read_content(ctx, f.nodeId))).text).toBe(f.accepted);
	},
);

test("native Save replaces a full legal frontmatter set with the current owner", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const markdown = (round: number) =>
		`---\n${Array.from({ length: 128 }, (_, key) => `k${key}: [r${round}v0, r${round}v1, r${round}v2]`).join(
			"\n",
		)}\n---\nContent\n`;
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/full.md",
		textContent: markdown(0),
	});
	expect(
		await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		}),
	).toHaveProperty("_yay");
	expect(
		await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: markdown(1),
		}),
	).toHaveProperty("_yay");
	const saved = await t.run((ctx) => read_content(ctx, nodeId));
	expect(saved.text).toBe(markdown(1));
	expect(saved.fields).toEqual(Array.from({ length: 128 }, (_, key) => `frontmatter.k${key}`).sort());
	expect(saved.values).toEqual(
		Array.from({ length: 128 }, (_, key) =>
			Array.from({ length: 3 }, (_, value) => [`frontmatter.k${key}`, `r1v${value}`]),
		)
			.flat()
			.sort(),
	);
	const docs = await t.run((ctx) =>
		ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect(),
	);
	expect(docs).toHaveLength(512);
	expect(
		docs.every((doc) => doc.sourceKind === "committed" && doc.contentHeadId === saved.headId),
		"all replacement fields use the current head",
	).toBe(true);
});

test("Move and reviewed Archive keep one selected content and metadata view", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/note.md",
		textContent: text,
	});
	await test_finish_saved_scope_jobs(t);
	const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "/target",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	const original = await t.run((ctx) => read_content(ctx, nodeId));
	expect(original.text).toBe(text);
	expect(original.exactIds).toHaveLength(1);
	expect(original.plain).toHaveLength(1);
	// Expose transaction boundaries with one file, without adding a large fixture.
	vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
	const observations: Array<Awaited<ReturnType<typeof read_content>>> = [];
	const move = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [nodeId],
		targetParentId: folder._yay.nodeId,
	});
	if (move._nay) throw new Error(move._nay.message);
	expect(
		await asUser.mutation(api.files_transfer.seal, {
			membershipId: db.membershipId,
			runId: move._yay.runId,
		}),
	).toEqual({ _yay: null });
	await test_finish_transfer_run(asUser, move._yay.runId, async () => {
		const current = await t.run((ctx) => read_content(ctx, nodeId));
		observations.push(current);
		const scope = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			path: current.node.path,
		};
		expect(
			await t.query(internal.files_nodes.read_file_content_from_chunks, {
				...scope,
				committedOnly: true,
				mode: { kind: "full", maxBytes: 1_000 },
			}),
		).toMatchObject({ content: text, target: { kind: "saved", id: nodeId } });
		expect(await t.query(internal.files_metadata.get_index_values_by_path, scope)).toMatchObject({
			fields: ["frontmatter.status", "frontmatter.topic"],
			values: [
				{ fieldPath: "frontmatter.status", valueKind: "string", stringValue: "saved" },
				{ fieldPath: "frontmatter.topic", valueKind: "string", stringValue: "ownership" },
			],
		});
	});
	await test_finish_saved_scope_jobs(t);
	const moved = await t.run((ctx) => read_content(ctx, nodeId));
	expect(moved.node.path).toBe("/target/note.md");
	expect(moved.node.updatedAt, "Move keeps the content modified time").toBe(original.node.updatedAt);
	expect(
		observations.some((row) => row.view?.view === "before" && row.hasAfterCopy),
		"observe staged derived copies",
	).toBe(true);
	expect(
		observations.some((row) => row.view?.view === "after"),
		"observe publication before cleanup",
	).toBe(true);

	// Review Archive uses the same location views as Move. The direct Archive door has its own stamp worker.
	vi.setSystemTime(Date.now() + 10_000);
	const archiveTime = Date.now();
	expect(
		await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: nodeId },
		}),
	).toHaveProperty("_yay");
	const proposal = await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique(),
	);
	if (!proposal) throw new Error("Expected the pending Archive");
	const archived = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
	});
	if (archived._nay) throw new Error(archived._nay.message);
	expect(
		await asUser.mutation(api.files_pending_update_runs.seal, {
			membershipId: db.membershipId,
			runId: archived._yay.runId,
		}),
	).toEqual({ _yay: null });
	const archiveObservations: typeof observations = [];
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const result = await handler(ctx, args);
		archiveObservations.push(await read_content(ctx, nodeId));
		return result;
	});
	await test_finish_pending_update_run(asUser, archived._yay.runId, { stepwise: true });
	await test_finish_saved_scope_jobs(t);
	const final = await t.run((ctx) => read_content(ctx, nodeId));
	expect(final.node.archiveOperationId).not.toBeNull();
	expect(final.node.updatedAt, "Archive keeps its later modified time after cleanup").toBe(archiveTime);
	expect(
		archiveObservations.some((row) => row.view?.view === "before" && row.hasAfterCopy),
		"observe Archive staging",
	).toBe(true);
	expect(
		archiveObservations.some((row) => row.view?.view === "after" && row.node.archiveOperationId !== null),
		"observe Archive publication",
	).toBe(true);
	for (const current of [...observations, moved, ...archiveObservations, final]) {
		expect(current.headId, "location work keeps the saved content owner").toBe(original.headId);
		expect(current.text, "exact reads do not repeat content from another location view").toBe(text);
		expect(current.exactIds).toEqual(original.exactIds);
		expect(
			current.plain.map((row) => ({ index: row.index, text: row.text })),
			"plain text has one doc per chunk",
		).toEqual(original.plain.map((row) => ({ index: row.index, text: row.text })));
		expect(
			current.plain.every((row) => row.view === undefined || row.view.view === current.view?.view),
			"plain text excludes the opposite view",
		).toBe(true);
		expect(current.fields, "frontmatter fields have no opposite-view duplicates").toEqual([
			"frontmatter.status",
			"frontmatter.topic",
		]);
		expect(current.values, "frontmatter values have no opposite-view duplicates").toEqual([
			["frontmatter.status", "saved"],
			["frontmatter.topic", "ownership"],
		]);
	}
});
