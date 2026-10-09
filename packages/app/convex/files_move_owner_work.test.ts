import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { files_u8_to_array_buffer, type files_PendingParent } from "../shared/files.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import {
	files_move_owner_work_db_abort,
	files_move_owner_work_db_collect_closure,
	files_move_owner_work_db_collect_node,
	files_move_owner_work_db_finish,
	files_move_owner_work_db_stage,
} from "./files_move_owner_work.ts";
import { files_move_reservations_db_wrap } from "../server/files-move-reservations.ts";
import {
	files_pending_overlay_db_flush,
	files_pending_overlay_db_set_cohort_allocation,
	files_pending_overlay_db_set_cohort_materialization,
	files_pending_overlay_db_set_cohort_staging,
	files_pending_overlay_db_wrap,
	files_pending_overlay_list,
} from "../server/files-pending-overlay.ts";
import { test_create_saved_placement_fixture as fixture } from "../server/files-saved-placement.test-fixtures.ts";
import {
	files_saved_content_collect,
	files_saved_content_db_plain_text_chunks,
} from "../server/files-saved-content.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("owner-work-test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	const objects = new Map<string, string | ArrayBuffer>();
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = crypto.randomUUID()) => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (path.startsWith("https://r2.test/upload?key=")) {
				const key = decodeURIComponent(path.slice("https://r2.test/upload?key=".length));
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			const body = objects.get(decodeURIComponent(path.slice("https://r2.test/object?key=".length)));
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mutation<T>(f: Fixture, handler: (ctx: MutationCtx) => Promise<T>) {
	return await f.t.run(async (ctx) => {
		const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
		const wrapped = { ...guarded, ...files_pending_overlay_db_wrap(guarded) };
		const result = await handler(wrapped);
		await files_pending_overlay_db_flush(wrapped);
		return result;
	});
}

const step_args = (f: Fixture) => ({ cohortId: f.cohortId, fence: 1, attemptFence: 1 });

async function phase(
	f: Fixture,
	workPhase: "owners_collect" | "owners_closure" | "owners_stage" | "finish_owners" | "abort_owners",
) {
	await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { workPhase }));
}

async function collect(f: Fixture, nodeRecordId = f.recordId) {
	await phase(f, "owners_collect");
	let cursor: string | null = null;
	for (let page = 0; page < 100; page++) {
		const result = await mutation(f, (ctx) =>
			files_move_owner_work_db_collect_node(ctx, { ...step_args(f), nodeRecordId, cursor }),
		);
		expect(result._nay).toBeUndefined();
		cursor = result._yay!.cursor;
		if (result._yay!.done) break;
		if (page === 99) throw new Error("Owner node collection did not finish");
	}
	await phase(f, "owners_closure");
	for (let page = 0; page < 300; page++) {
		const result = await mutation(f, (ctx) => files_move_owner_work_db_collect_closure(ctx, step_args(f)));
		expect(result._nay).toBeUndefined();
		if (result._yay!.done) return;
	}
	throw new Error("Owner closure did not finish");
}

async function stage(f: Fixture) {
	await phase(f, "owners_stage");
	for (let page = 0; page < 400; page++) {
		const result = await mutation(f, (ctx) => files_move_owner_work_db_stage(ctx, step_args(f)));
		expect(result._nay).toBeUndefined();
		if (result._yay!.done) return;
	}
	throw new Error("Owner staging did not finish");
}

async function cleanup(f: Fixture, mode: "finish" | "abort") {
	await f.t.run((ctx) =>
		ctx.db.patch("files_move_cohorts", f.cohortId, {
			phase: mode === "finish" ? "finishing" : "aborting",
			workPhase: mode === "finish" ? "finish_owners" : "abort_owners",
			visibleView: mode === "finish" ? "after" : "before",
		}),
	);
	for (let page = 0; page < 400; page++) {
		const result = await mutation(f, (ctx) =>
			mode === "finish"
				? files_move_owner_work_db_finish(ctx, step_args(f))
				: files_move_owner_work_db_abort(ctx, step_args(f)),
		);
		expect(result._nay).toBeUndefined();
		if (result._yay!.done) return;
	}
	throw new Error("Owner cleanup did not finish");
}

async function add_owners(f: Fixture, count: number) {
	for (let index = 0; index < count; index++) {
		const home = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		vi.setSystemTime(Date.now() + 10_000);
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: home.userId,
			}),
		).toEqual({ _yay: null });
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: home.userId,
			target: { kind: "saved", id: f.nodeId },
			destParent: { kind: "saved", id: f.parentId },
			destName: `owner-${index}.txt`,
		});
		expect(moved._nay).toBeUndefined();
	}
}

async function private_folder(f: Fixture, name: string, parent: files_PendingParent = { kind: "root" }) {
	return await mutation(f, async (ctx) => {
		const created = await files_pending_nodes_db_create(ctx, { ...f.db, parent, name, kind: "folder" });
		if (created._nay) throw new Error(created._nay.message);
		await ctx.db.patch("files_pending_updates", created._yay.pendingUpdateId, {
			createIntent: { kind: "folder", metadata: [] },
		});
		return created._yay;
	});
}

async function native_pending_scope() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/source.md",
		textContent: "Saved body.\n",
	});
	const target = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "/target",
	});
	if (target._nay) throw new Error(target._nay.message);
	const other = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	expect(
		await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userIdToAdd: other.userId,
		}),
	).toEqual({ _yay: null });
	const proposals: Doc<"files_pending_updates">[] = [];
	for (const userId of [db.userId, other.userId]) {
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId };
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target: { kind: "saved", id: nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const frontmatter = Array.from({ length: 12 }, (_, index) => `key${index}: value${index}`).join("\n");
		expect(
			await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...scope,
				operationBatchId: batch._yay.operationBatchId,
				role: "unstaged",
				text: `---\n${frontmatter}\n---\n\n${"Owner body.\n\n".repeat(1400)}`,
			}),
		).toEqual({ _yay: null });
		expect(
			await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target: { kind: "saved", id: nodeId },
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		const proposal = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) => q.eq("userId", userId).eq("target.kind", "saved").eq("target.id", nodeId))
				.unique(),
		);
		if (!proposal) throw new Error("Expected the native pending branch");
		proposals.push(proposal);
	}
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sourceIds: [nodeId],
		expectedSourceCount: 1,
		targetParentId: target._yay.nodeId,
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
		if (slot?.cohortId) return { t, db, asUser, nodeId, runId, cohortId: slot.cohortId, proposals };
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.first(),
		);
		if (job)
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
		else await t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("The public Move did not start its cohort");
}

async function pending_scope_docs(
	f: Awaited<ReturnType<typeof native_pending_scope>>,
	proposal: Doc<"files_pending_updates">,
	view?: "before" | "after",
) {
	return await f.t.run(async (ctx) => ({
		plain: await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q
					.eq("pendingUpdateId", proposal._id)
					.eq("moveView.cohortId", view ? f.cohortId : undefined)
					.eq("moveView.view", view),
			)
			.collect(),
		metadata: await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_pendingUpdate_fieldPath", (q) =>
				q
					.eq("pendingUpdateId", proposal._id)
					.eq("moveView.cohortId", view ? f.cohortId : undefined)
					.eq("moveView.view", view),
			)
			.collect(),
	}));
}

test("public Move seals unselected pending scope before the switch and keeps each branch", async () => {
	const f = await native_pending_scope();
	const originals = await Promise.all(f.proposals.map((proposal) => pending_scope_docs(f, proposal)));
	expect(
		originals.every((docs) => docs.plain.length > 8 && docs.metadata.length > 8),
		"native branches need several scope pages",
	).toBe(true);
	for (let pass = 0; pass < 1000; pass++) {
		const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		if (cohort.workPhase === "publish") break;
		expect(cohort.errorCode).toBeNull();
		await f.t.action(internal.files_move_cohorts.run, { cohortId: f.cohortId, step: cohort.step });
		if (pass === 999) throw new Error("Pending scope staging did not finish");
	}
	for (const [index, proposal] of f.proposals.entries()) {
		const before = await pending_scope_docs(f, proposal, "before");
		const after = await pending_scope_docs(f, proposal, "after");
		const metadata = await f.t.query(internal.files_metadata.get_by_path, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: proposal.userId,
			overlayUserId: proposal.userId,
			path: "/source.md",
		});
		expect(metadata?.sourceKind, "Bash metadata keeps an unselected pending branch during staging").toBe("pending");
		expect(metadata?.fields.sort(), "Bash metadata keeps all pending fields during staging").toEqual(
			originals[index]!.metadata.filter((doc) => doc.docKind === "field")
				.map((doc) => doc.fieldPath)
				.sort(),
		);
		expect(after.plain, "unselected pending scope follows the saved Move before cleanup").toHaveLength(
			originals[index]!.plain.length,
		);
		expect(await pending_scope_docs(f, proposal)).toEqual({ plain: [], metadata: [] });
		expect(before.plain.map((doc) => doc._id)).toEqual(originals[index]!.plain.map((doc) => doc._id));
		expect(before.plain.every((doc) => doc.path === "/source.md")).toBe(true);
		expect(after.plain.length).toBe(before.plain.length);
		expect(after.plain.every((doc) => doc.path === "/target/source.md")).toBe(true);
		expect(after.metadata.length).toBe(before.metadata.length);
		expect(
			after.metadata.every((doc) => doc.path === "/target/source.md" && doc.treePath === "/target/source.md"),
		).toBe(true);
		expect(after.plain.map((doc) => "textChunkId" in doc && doc.textChunkId)).toEqual(
			before.plain.map((doc) => "textChunkId" in doc && doc.textChunkId),
		);
		const point = await f.t.run((ctx) =>
			files_saved_content_collect(
				files_saved_content_db_plain_text_chunks(ctx.db, {
					...f.db,
					pendingUpdateId: proposal._id,
					fixedView: { cohortId: f.cohortId, view: "before" },
				}),
			),
		);
		expect(
			point.map((doc) => doc._id),
			"before point reads keep every original chunk",
		).toEqual(before.plain.map((doc) => doc._id));
	}
	const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
	await f.t.action(internal.files_move_cohorts.run, { cohortId: f.cohortId, step: cohort.step });
	for (const proposal of f.proposals) {
		const metadata = await f.t.query(internal.files_metadata.get_by_path, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: proposal.userId,
			overlayUserId: proposal.userId,
			path: "/target/source.md",
		});
		expect(metadata?.sourceKind, "Bash metadata keeps an unselected pending branch after publication").toBe("pending");
		expect(metadata?.fields.sort(), "Bash metadata keeps all pending fields after publication").toEqual(
			originals[0]!.metadata
				.filter((doc) => doc.docKind === "field")
				.map((doc) => doc.fieldPath)
				.sort(),
		);
		const point = await f.t.run((ctx) =>
			files_saved_content_collect(
				files_saved_content_db_plain_text_chunks(ctx.db, { ...f.db, pendingUpdateId: proposal._id }),
			),
		);
		expect(point.length).toBe(originals[0]!.plain.length);
		expect(
			point.every((doc) => doc.path === "/target/source.md"),
			"after point reads use sealed pending scope",
		).toBe(true);
	}
	await test_finish_transfer_run(f.asUser, f.runId);
	expect(
		(await f.asUser.query(api.files_transfer.get, { membershipId: f.db.membershipId, runId: f.runId }))?.activity
			.status,
	).toBe("succeeded");
	for (const [index, proposal] of f.proposals.entries()) {
		const final = await pending_scope_docs(f, proposal);
		expect(final.plain.map((doc) => doc.plainTextChunk)).toEqual(
			originals[index]!.plain.map((doc) => doc.plainTextChunk),
		);
		expect(final.plain.every((doc) => doc.path === "/target/source.md")).toBe(true);
		expect(final.metadata.map((doc) => [doc.fieldPath, doc.docKind, doc.stringValue])).toEqual(
			originals[index]!.metadata.map((doc) => [doc.fieldPath, doc.docKind, doc.stringValue]),
		);
		expect(
			await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id)),
			"unselected branch headers are unchanged",
		).toEqual(proposal);
		expect(await pending_scope_docs(f, proposal, "before")).toEqual({ plain: [], metadata: [] });
		expect(await pending_scope_docs(f, proposal, "after")).toEqual({ plain: [], metadata: [] });
	}
}, 120_000);

test("public Stop restores a partly staged unselected pending scope page", async () => {
	const f = await native_pending_scope();
	const proposal = f.proposals[0]!;
	const original = await pending_scope_docs(f, proposal);
	for (let pass = 0; pass < 1000; pass++) {
		const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		const before = await pending_scope_docs(f, proposal, "before");
		if (before.plain.length > 0) break;
		expect(cohort.publishedAt).toBeNull();
		await f.t.action(internal.files_move_cohorts.run, { cohortId: f.cohortId, step: cohort.step });
		if (pass === 999) throw new Error("Pending scope did not start");
	}
	expect(
		(await pending_scope_docs(f, proposal)).plain.length,
		"Stop interrupts a native pending scope page",
	).toBeGreaterThan(0);
	expect(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId: f.runId })).toEqual(
		{ _yay: null },
	);
	await test_finish_transfer_run(f.asUser, f.runId);
	expect(
		(await f.asUser.query(api.files_transfer.get, { membershipId: f.db.membershipId, runId: f.runId }))?.activity
			.status,
	).toBe("canceled");
	expect(await pending_scope_docs(f, proposal), "abort restores original pending content and metadata IDs").toEqual(
		original,
	);
	for (const row of f.proposals) {
		expect(await pending_scope_docs(f, row, "before")).toEqual({ plain: [], metadata: [] });
		expect(await pending_scope_docs(f, row, "after")).toEqual({ plain: [], metadata: [] });
	}
	expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.path).toBe("/source.md");
}, 120_000);

test("public Move leaves unrelated drafts under an unchanged anchor in place", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	async function saved_folder(path: string) {
		const result = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (result._nay) throw new Error(result._nay.message);
		return result._yay.nodeId;
	}
	await saved_folder("/source");
	const targetId = await saved_folder("/target");
	await saved_folder("/elsewhere");
	const movingId = await saved_folder("/source/moving");
	const affected = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path: "/source/moving/affected",
		kind: "folder",
	});
	if (affected._nay || !affected._yay.pendingUpdateId) throw new Error("Expected the affected private child");
	const affectedTarget = affected._yay.target;
	const unrelated: { proposal: Doc<"files_pending_updates">; path: string }[] = [];
	for (let index = 0; index < 9; index++) {
		const name = String(index).padStart(2, "0");
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: `/target/private-${name}`,
			kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected an unrelated private child");
		const incomingId = await saved_folder(`/elsewhere/incoming-${name}`);
		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...scope,
					target: { kind: "saved", id: incomingId },
					destParent: { kind: "saved", id: targetId },
					destName: `incoming-${name}`,
				})
			)._nay,
		).toBeUndefined();
		for (const path of [`/target/private-${name}`, `/target/incoming-${name}`]) {
			expect(
				(
					await t.mutation(internal.files_metadata.update_entries_by_path, {
						...scope,
						path,
						set: Array.from({ length: index === 0 ? 9 : 1 }, (_, field) => ({
							key: `note${field}`,
							value: `${path}:${field}`,
						})),
						remove: [],
					})
				)._nay,
			).toBeUndefined();
			const entry = await t.query(internal.files_visible.internal_get_by_path, { ...scope, path });
			if (!entry?.pendingUpdate) throw new Error("Expected the unrelated native proposal");
			unrelated.push({ proposal: entry.pendingUpdate, path });
		}
	}
	expect(
		(
			await t.mutation(internal.files_metadata.update_entries_by_path, {
				...scope,
				path: "/source/moving/affected",
				set: [{ key: "affected", value: "kept" }],
				remove: [],
			})
		)._nay,
	).toBeUndefined();
	for (let pass = 0; pass < 1000; pass++) {
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.first(),
		);
		if (!job) break;
		await t.mutation(internal.files_pending_overlay.run_job, {
			kind: job.kind,
			key: job.key,
			nextAttemptAt: job.nextAttemptAt,
		});
		if (pass === 999) throw new Error("Native draft setup did not finish");
	}
	async function owner_docs(
		proposal: Doc<"files_pending_updates">,
		view?: "before" | "after",
		cohortId?: Doc<"files_move_cohorts">["_id"],
	) {
		const target = proposal.target;
		return await t.run(async (ctx) => {
			const places = await ctx.db
				.query("files_pending_places")
				.withIndex("by_pendingUpdate", (q) =>
					q
						.eq("pendingUpdateId", proposal._id)
						.eq("moveView.cohortId", view ? cohortId : undefined)
						.eq("moveView.view", view),
				)
				.collect();
			return {
				places,
				fields: (
					await Promise.all(
						places.map((place) =>
							ctx.db
								.query("files_pending_place_fields")
								.withIndex("by_place", (q) =>
									q
										.eq("placeId", place._id)
										.eq("moveView.cohortId", view ? cohortId : undefined)
										.eq("moveView.view", view),
								)
								.collect(),
						),
					)
				).flat(),
				lists: await ctx.db
					.query("files_pending_list_rows")
					.withIndex("by_pendingUpdate", (q) =>
						q
							.eq("pendingUpdateId", proposal._id)
							.eq("moveView.cohortId", view ? cohortId : undefined)
							.eq("moveView.view", view),
					)
					.collect(),
				metadata:
					target.kind === "private"
						? await ctx.db
								.query("files_metadata_docs")
								.withIndex("by_pendingUpdate_fieldPath", (q) =>
									q
										.eq("pendingUpdateId", proposal._id)
										.eq("moveView.cohortId", view ? cohortId : undefined)
										.eq("moveView.view", view),
								)
								.collect()
						: await ctx.db
								.query("files_metadata_docs")
								.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
									q
										.eq("organizationId", db.organizationId)
										.eq("workspaceId", db.workspaceId)
										.eq("fileNodeId", target.id)
										.eq("moveView.cohortId", view ? cohortId : undefined)
										.eq("moveView.view", view),
								)
								.collect(),
			};
		});
	}
	async function paths(folderPath: string) {
		let cursor: string | null = null;
		const result: string[] = [];
		for (let page = 0; page < 100; page++) {
			// Fix the page type to break its cursor inference loop.
			const current: Awaited<ReturnType<typeof files_pending_overlay_list>> = await files_pending_overlay_list(
				{ runQuery: t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					overlayUserId: db.userId,
					folderPath,
					mode: "children",
					order: "asc",
					numItems: 3,
					cursor,
				},
			);
			if (current._nay) throw new Error(current._nay.message);
			result.push(...current._yay.items.map((entry) => `${entry.target.kind}:${entry.target.id}:${entry.path}`));
			if (current._yay.isDone) return result;
			cursor = current._yay.continueCursor;
		}
		throw new Error("Native visible list did not finish");
	}
	const originalDocs = await Promise.all(unrelated.map(({ proposal }) => owner_docs(proposal)));
	expect(unrelated, "both unrelated anchor ranges exceed one owner page").toHaveLength(18);
	expect(originalDocs[0]!.metadata.length).toBeGreaterThan(8);
	expect(originalDocs[1]!.metadata.length).toBeGreaterThan(8);
	const originalPaths = await paths("/target");
	expect(originalPaths).toHaveLength(18);
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sourceIds: [movingId],
		expectedSourceCount: 1,
		targetParentId: targetId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	let cohort: Doc<"files_move_cohorts"> | null = null;
	for (let pass = 0; pass < 2000; pass++) {
		const slot = await t.run((ctx) =>
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique(),
		);
		cohort = slot?.cohortId ? await t.run((ctx) => ctx.db.get("files_move_cohorts", slot.cohortId!)) : null;
		if (cohort?.workPhase === "publish") break;
		if (cohort) {
			expect(cohort.errorCode).toBeNull();
			await t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
		} else await t.mutation(internal.files_transfer.advance, { runId });
		if (pass === 1999) throw new Error("Native anchor Move did not reach publication");
	}
	if (!cohort) throw new Error("Expected the native cohort");
	const cohortId = cohort._id;
	const anchor = await t.run((ctx) =>
		ctx.db
			.query("files_move_cohort_nodes")
			.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", targetId))
			.unique(),
	);
	expect(anchor?.role, "the destination is an unchanged native anchor").toBe("anchor");
	const before = await t.run((ctx) => ctx.db.get("files_saved_places", anchor!.beforePlaceId!));
	const after = await t.run((ctx) => ctx.db.get("files_saved_places", anchor!.afterPlaceId!));
	expect({ ...after, _id: before!._id, _creationTime: before!._creationTime, view: "before" }).toEqual(before);
	const unrelatedWork = await t.run(async (ctx) =>
		Promise.all(
			unrelated.map(({ proposal }) =>
				ctx.db
					.query("files_move_owner_work")
					.withIndex("by_cohort_owner_target", (q) =>
						q
							.eq("cohortId", cohortId)
							.eq("userId", proposal.userId)
							.eq("target.kind", proposal.target.kind)
							.eq("target.id", proposal.target.id),
					)
					.unique(),
			),
		),
	);
	expect(unrelatedWork.filter(Boolean), "unchanged anchors do not collect unrelated owner work").toEqual([]);
	const affectedWork = await t.run((ctx) =>
		ctx.db
			.query("files_move_owner_work")
			.withIndex("by_cohort_owner_target", (q) =>
				q
					.eq("cohortId", cohortId)
					.eq("userId", db.userId)
					.eq("target.kind", "private")
					.eq("target.id", affectedTarget.id),
			)
			.unique(),
	);
	expect(affectedWork?.status, "changed folders still stage their affected private children").toBe("validated");
	async function check_unrelated(published: boolean) {
		const visible = await paths("/target");
		expect(
			visible.filter((entry) => !entry.endsWith(":/target/moving")),
			"unrelated draft paths stay visible once",
		).toEqual(originalPaths);
		for (const [index, { proposal, path }] of unrelated.entries()) {
			expect(await owner_docs(proposal), "unrelated normal doc IDs stay unchanged").toEqual(originalDocs[index]);
			for (const view of ["before", "after"] as const)
				expect(await owner_docs(proposal, view, cohortId), "unrelated drafts need no selected side copies").toEqual({
					places: [],
					fields: [],
					lists: [],
					metadata: [],
				});
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
			for (const source of [{ kind: "proposal" as const, id: proposal._id }, proposal.target])
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("files_move_source_reservations")
							.withIndex("by_source", (q) => q.eq("source.kind", source.kind).eq("source.id", source.id))
							.unique(),
					),
					"unrelated drafts need no source reservation",
				).toBeNull();
			const metadata = await t.query(internal.files_metadata.get_by_path, { ...scope, overlayUserId: db.userId, path });
			expect(metadata?.sourceKind).toBe(proposal.target.kind === "private" ? "pending" : "committed");
			expect(metadata?.fields.sort()).toEqual(
				originalDocs[index]!.metadata.filter((row) => row.docKind === "field")
					.map((row) => row.fieldPath)
					.sort(),
			);
		}
		const affectedPath = published ? "/target/moving/affected" : "/source/moving/affected";
		expect(
			await asUser.query(api.files_visible.get_path, { membershipId: db.membershipId, target: affectedTarget }),
			"the affected child follows the real folder switch",
		).toBe(affectedPath);
		const affectedMetadata = await t.query(internal.files_metadata.get_by_path, {
			...scope,
			overlayUserId: db.userId,
			path: affectedPath,
		});
		expect(affectedMetadata?.fields).toEqual(["metadata.affected"]);
	}
	await check_unrelated(false);
	await t.action(internal.files_move_cohorts.run, { cohortId, step: cohort.step });
	await check_unrelated(true);
	cohort = (await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))!;
	expect(cohort.phase).toBe("published");
	for (let pass = 0; pass < 1000; pass++) {
		await t.action(internal.files_move_cohorts.run, { cohortId, step: cohort.step });
		cohort = (await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))!;
		if (cohort.workPhase === "finish_nodes" && cohort.cleanupCursor) break;
		if (pass === 999) throw new Error("Native cleanup did not start its node page");
	}
	await check_unrelated(true);
	await test_finish_transfer_run(asUser, runId);
	expect((await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.status).toBe(
		"succeeded",
	);
	await check_unrelated(true);
}, 600_000);

test("collects and stages several native owner pages once, then keeps chosen IDs during cleanup", async () => {
	const f = await fixture();
	await add_owners(f, 12);
	await collect(f);
	const read_work = () =>
		f.t.run((ctx) =>
			ctx.db
				.query("files_move_owner_work")
				.withIndex("by_cohort_order", (q) => q.eq("cohortId", f.cohortId))
				.collect(),
		);
	const planned = await read_work();
	expect(planned, "every native owner proposal is collected once").toHaveLength(13);
	expect(new Set(planned.map((row) => `${row.userId}:${row.target.id}`)).size).toBe(13);
	expect(planned.every((row) => row.status === "planned")).toBe(true);
	await stage(f);
	const staged = await read_work();
	expect(staged.every((row) => row.status === "staged")).toBe(true);
	const originals = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", f.nodeId))
			.collect(),
	);
	expect((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))?.pendingWorkCount).toBe(0);
	await cleanup(f, "finish");
	for (const work of staged) {
		if (work.afterPlaceId)
			expect(
				(await f.t.run((ctx) => ctx.db.get("files_pending_places", work.afterPlaceId!)))?.moveView,
			).toBeUndefined();
		if (work.beforePlaceId)
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_places", work.beforePlaceId!))).toBeNull();
	}
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", f.nodeId))
				.collect(),
		),
		"unselected proposal headers are preserved",
	).toEqual(originals);
	expect((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))?.pendingWorkCount).toBe(0);
});

test("closes after-only private parent aliases and restores partial owner staging on abort", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const parent = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path: "/private-parent",
		kind: "folder",
	});
	if (parent._nay || parent._yay.target.kind !== "private" || !parent._yay.pendingUpdateId)
		throw new Error("Expected the native private parent");
	const parentTarget = parent._yay.target;
	const children: Doc<"files_pending_nodes">["_id"][] = [];
	for (let index = 0; index < 13; index++) {
		const child = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: `/private-parent/child-${index}`,
			kind: "folder",
		});
		if (child._nay || child._yay.target.kind !== "private") throw new Error("Expected a native private child");
		children.push(child._yay.target.id);
	}
	const incoming = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "/incoming",
	});
	if (incoming._nay) throw new Error(incoming._nay.message);
	const incomingTarget = { kind: "saved" as const, id: incoming._yay.nodeId };
	expect(
		(
			await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target: incomingTarget,
				destParent: parentTarget,
				destName: "incoming",
			})
		)._nay,
	).toBeUndefined();
	for (let pass = 0; pass < 1000; pass++) {
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.first(),
		);
		if (!job) break;
		await t.mutation(internal.files_pending_overlay.run_job, {
			kind: job.kind,
			key: job.key,
			nextAttemptAt: job.nextAttemptAt,
		});
		if (pass === 999) throw new Error("Native alias setup did not finish");
	}
	const originalPlaces = await t.run(async (ctx) =>
		Promise.all(
			children.map((id) =>
				ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q
							.eq("target.kind", "private")
							.eq("target.id", id)
							.eq("userId", db.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.unique(),
			),
		),
	);
	const incomingProposal = await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", incomingTarget.id),
			)
			.unique(),
	);
	const selected = (await t.run((ctx) => ctx.db.get("files_pending_updates", parent._yay.pendingUpdateId!)))!;
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [{ pendingUpdateId: selected._id, reviewedRevision: selected.revision, selectedContentStateId: null }],
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	let cohort: Doc<"files_move_cohorts"> | null = null;
	for (let pass = 0; pass < 2000; pass++) {
		const slot = await t.run((ctx) =>
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique(),
		);
		cohort = slot?.cohortId ? await t.run((ctx) => ctx.db.get("files_move_cohorts", slot.cohortId!)) : null;
		if (cohort?.workPhase === "owners_stage") {
			const staged = await t.run((ctx) =>
				ctx.db
					.query("files_move_owner_work")
					.withIndex("by_cohort_owner_target", (q) =>
						q
							.eq("cohortId", cohort!._id)
							.eq("userId", db.userId)
							.eq("target.kind", "private")
							.eq("target.id", children[0]!),
					)
					.unique(),
			);
			if (staged?.status === "staged") break;
		}
		if (cohort) {
			expect(cohort.errorCode).toBeNull();
			await t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
		} else {
			const run = (await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))!;
			if (run.step === "planning") await t.action(internal.files_pending_update_runs.plan, { runId, fence: run.fence });
			else await t.mutation(internal.files_pending_update_runs.advance, { runId });
		}
		if (pass === 1999) throw new Error("Native Review did not start partial owner staging");
	}
	if (!cohort) throw new Error("Expected the native Review cohort");
	const cohortId = cohort._id;
	const receipt = await t.run((ctx) =>
		ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", (q) =>
				q.eq("privateNodeId", parentTarget.id).eq("moveView.cohortId", cohortId).eq("moveView.view", "after"),
			)
			.unique(),
	);
	expect(receipt, "native private Save creates the exact AFTER publication receipt").not.toBeNull();
	expect(receipt!.savedNodeId, "allocation creates a fresh saved ID").not.toBe(incomingTarget.id);
	const record = await t.run((ctx) =>
		ctx.db
			.query("files_move_cohort_nodes")
			.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", receipt!.savedNodeId))
			.unique(),
	);
	expect(record?.role, "the AFTER receipt belongs to an allocated node").toBe("allocated");
	expect(record?.beforePlaceId).toBeNull();
	expect(cohort.publishedAt).toBeNull();
	const work = await t.run((ctx) =>
		ctx.db
			.query("files_move_owner_work")
			.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId))
			.collect(),
	);
	expect(
		work
			.filter((row) => row.target.kind === "private" && row.target.id !== parentTarget.id)
			.map((row) => row.target.id)
			.sort(),
		"an after-only receipt keeps all unselected private children",
	).toEqual([...children].sort());
	expect(
		work.some((row) => row.target.kind === "saved" && row.target.id === incomingTarget.id),
		"incoming moves follow the same private alias",
	).toBe(true);
	expect(
		work.some((row) => row.target.kind === "private" && row.target.id === children[0] && row.status === "staged") &&
			work.some((row) => row.target.kind === "private" && children.includes(row.target.id) && row.status === "planned"),
		"Stop interrupts partial native owner staging",
	).toBe(true);
	expect(
		await asUser.mutation(api.activities.request_stop, {
			membershipId: db.membershipId,
			activityId: started._yay.activityId,
		}),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 2000; pass++) {
		cohort = (await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))!;
		if (cohort.phase === "complete") break;
		await t.action(internal.files_move_cohorts.run, { cohortId, step: cohort.step });
		if (pass === 1999) throw new Error("Native alias abort did not finish");
	}
	await test_finish_pending_update_run(asUser, runId);
	expect((await t.run((ctx) => ctx.db.get("activities", started._yay.activityId)))?.status).toBe("canceled");
	expect(
		(await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))?.pendingWorkCount,
		"abort settles unfinished owner range counts",
	).toBe(0);
	for (const child of [parentTarget.id, ...children])
		expect((await t.run((ctx) => ctx.db.get("files_pending_nodes", child)))?.state).toBe("active");
	expect(
		await t.run(async (ctx) =>
			Promise.all(
				children.map((id) =>
					ctx.db
						.query("files_pending_places")
						.withIndex("by_target_user", (q) =>
							q
								.eq("target.kind", "private")
								.eq("target.id", id)
								.eq("userId", db.userId)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined),
						)
						.unique(),
				),
			),
		),
		"abort restores every original private place ID",
	).toEqual(originalPlaces);
	expect(
		await t.run((ctx) => ctx.db.get("files_pending_updates", incomingProposal!._id)),
		"Stop preserves the incoming pending Move identity",
	).toEqual(incomingProposal);
	expect(
		await t.run((ctx) =>
			ctx.db
				.query("files_pending_places")
				.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", cohortId))
				.collect(),
		),
	).toEqual([]);
	expect(
		await t.run((ctx) => ctx.db.get("files_nodes", receipt!.savedNodeId)),
		"abort deletes only the unexposed allocated saved node",
	).toBeNull();
}, 600_000);

test("source marker staging does not flush native crowded owner copies", async () => {
	const f = await fixture();
	await add_owners(f, 12);
	await f.t.run((ctx) =>
		ctx.db.insert("files_move_source_reservations", {
			cohortId: f.cohortId,
			source: { kind: "saved", id: f.nodeId },
			mode: "placement",
			userId: null,
			generation: 1,
		}),
	);
	const cost = await f.t.run(async (ctx) => {
		const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
		const wrapped = { ...guarded, ...files_pending_overlay_db_wrap(guarded) };
		const before = await ctx.meta.getTransactionMetrics();
		expect((await files_pending_overlay_db_set_cohort_staging(wrapped, step_args(f)))._nay).toBeUndefined();
		await wrapped.db.patch("files_nodes", f.nodeId, { moveCohortId: f.cohortId });
		await files_pending_overlay_db_flush(wrapped);
		const after = await ctx.meta.getTransactionMetrics();
		return {
			docs: after.documentsRead.used - before.documentsRead.used,
			writes: after.documentsWritten.used - before.documentsWritten.used,
		};
	});
	expect(cost.docs, "source marking does not read owner copies").toBeLessThan(20);
	expect(cost.writes).toBe(1);
	await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "finishing", visibleView: "after" }));
	const releaseCost = await f.t.run(async (ctx) => {
		const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
		const wrapped = { ...guarded, ...files_pending_overlay_db_wrap(guarded) };
		const before = await ctx.meta.getTransactionMetrics();
		expect(
			(await files_pending_overlay_db_set_cohort_materialization(wrapped, { ...step_args(f), mode: "finish" }))._nay,
		).toBeUndefined();
		await wrapped.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined });
		await files_pending_overlay_db_flush(wrapped);
		return (await ctx.meta.getTransactionMetrics()).documentsRead.used - before.documentsRead.used;
	});
	expect(releaseCost, "source marker release does not read owner copies").toBeLessThan(20);
});

test("owner collection rejects stale attempts and stale page replies", async () => {
	const f = await fixture();
	await phase(f, "owners_collect");
	const args = { ...step_args(f), nodeRecordId: f.recordId, cursor: null };
	expect(
		(await mutation(f, (ctx) => files_move_owner_work_db_collect_node(ctx, { ...args, attemptFence: 0 })))._nay?.name,
	).toBe("stopped");
	expect((await mutation(f, (ctx) => files_move_owner_work_db_collect_node(ctx, args)))._nay).toBeUndefined();
	expect((await mutation(f, (ctx) => files_move_owner_work_db_collect_node(ctx, args)))._nay?.name).toBe("stopped");
});

test("reserved private allocation does not start a normal saved overlay job", async () => {
	const f = await fixture();
	const privateNodeId = (await private_folder(f, "allocated")).privateNodeId;
	await f.t.run((ctx) =>
		ctx.db.insert("files_move_source_reservations", {
			cohortId: f.cohortId,
			source: { kind: "private", id: privateNodeId },
			mode: "subtree",
			userId: f.db.userId,
			generation: 1,
		}),
	);
	const nodeId = await mutation(f, async (ctx) => {
		expect(
			(await files_pending_overlay_db_set_cohort_allocation(ctx, { ...step_args(f), privateNodeId }))._nay,
		).toBeUndefined();
		const { _id, _creationTime, ...folder } = (await ctx.db.get("files_nodes", f.parentId))!;
		const fields = {
			...folder,
			parentId: "root" as const,
			name: "allocated",
			sortName: "allocated",
			path: "/allocated",
			treePath: "/allocated/",
			pathDepth: 1,
			moveCohortId: f.cohortId,
			publishedFromPrivateNodeId: privateNodeId,
		};
		const nodeId = await ctx.db.insert("files_nodes", fields);
		const { createdBy, writePolicy, newChildWritePolicy, moveCohortId, ...header } = fields;
		await ctx.db.insert("files_saved_places", {
			...header,
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			cohortId: f.cohortId,
			view: "after",
			nodeId,
			nodeCreationTime: (await ctx.db.get("files_nodes", nodeId))!._creationTime,
			contentId: null,
		});
		return nodeId;
	});
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "saved_node").eq("key", nodeId))
				.first(),
		),
		"after-only allocation does not schedule a normal saved job",
	).toBeNull();
});
