// Saved writes queue copied dates and search fields. Draft content and paths stay exact.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { files_pending_overlay_SavedPlacesCursor } from "../server/files-pending-overlay.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { add_member, fixture, type Fixture } from "./files_pending_overlay.setup.test.ts";
import {
	test_create_saved_text_file,
	test_finish_file_index,
	test_meta_search,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function saved_job(f: Fixture, nodeId: Id<"files_nodes">) {
	return await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", "saved_places").eq("key", nodeId))
			.unique(),
	);
}

async function fields_of(f: Fixture, placeId: Id<"files_pending_places">) {
	return await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_place_fields")
			.withIndex("by_place", (q) =>
				q.eq("placeId", placeId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.collect(),
	);
}

function field_payload(
	field: Pick<
		Doc<"files_pending_place_fields">,
		"docKind" | "fieldPath" | "valueKind" | "stringValue" | "numberValue" | "booleanValue"
	>,
) {
	return JSON.stringify([
		field.docKind,
		field.fieldPath,
		field.valueKind ?? null,
		field.stringValue ?? null,
		field.numberValue ?? null,
		field.booleanValue ?? null,
	]);
}

async function build_with_values(f: Fixture, nodeId: Id<"files_nodes">) {
	for (let step = 0; step < 100; step++) {
		const job = await saved_job(f, nodeId);
		if (!job || job.kind !== "saved_places") throw new Error("Expected a saved-place build");
		const cursor = job.cursor ? (JSON.parse(job.cursor) as files_pending_overlay_SavedPlacesCursor) : null;
		if (cursor?.place?.phase === "build" && cursor.place.page !== null) {
			const fields = await fields_of(f, cursor.place.id);
			if (fields.some((field) => field.fieldsRefreshId === cursor.place!.refreshId && field.docKind === "value"))
				return { job, cursor };
		}
		await f.run_job("saved_places", nodeId);
	}
	throw new Error("The unfinished build did not write a value");
}

async function metadata_fixture(count = 2) {
	const f = await fixture(true);
	const node = await f.saved(null, "notes.md");
	await f.set_metadata(node.path, [{ key: "status", value: "old" }]);
	await test_finish_file_index(f.t, node._id);
	const owners = [f.v];
	for (let index = 1; index < count; index++)
		owners.push(await f.t.run((ctx) => add_member(ctx, f.u, `saved_place_${index}`)));
	for (const [index, owner] of owners.entries())
		await f.draft_move({ kind: "saved", id: node._id }, { kind: "root" }, `owner-${index}.md`, owner);
	await f.settle();
	return { f, node, owners };
}

describe("files_pending_overlay saved places", () => {
	test("Save and version Restore keep other drafts exact and refresh copied dates later", async () => {
		const f = await fixture(true);
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/notes.txt",
			textContent: "Original text\n",
		});
		const snapshot = await f.t.run((ctx) => ctx.db.query("files_snapshots").first());
		expect(snapshot).not.toBeNull();
		expect(
			await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		const owners = [f.v, await f.t.run((ctx) => add_member(ctx, f.u, "saved_place_second"))];
		for (const [index, owner] of owners.entries()) {
			const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
			const batch = await f.t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					...owner,
					target: { kind: "saved", id: nodeId },
					expectedPendingContentVersion: node.pendingContentVersion,
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			for (const role of ["staged", "unstaged"] as const) {
				const staged = await f.t.mutation(
					internal.files_pending_updates.stage_file_pending_update_text_input_internal,
					{
						...owner,
						operationBatchId: batch._yay.operationBatchId,
						role,
						text: `Owner ${index} ${role}\n`,
					},
				);
				if (staged._nay) throw new Error(staged._nay.message);
			}
			const proposed = await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...owner,
				target: { kind: "saved", id: nodeId },
				operationBatchId: batch._yay.operationBatchId,
			});
			if (proposed._nay) throw new Error(proposed._nay.message);
			await f.draft_move({ kind: "saved", id: nodeId }, { kind: "root" }, `owner-${index}.txt`, owner);
		}
		await f.settle();
		const read_drafts = () =>
			f.t.run(async (ctx) => {
				const drafts = await Promise.all(
					owners.map((owner) =>
						ctx.db
							.query("files_pending_updates")
							.withIndex("by_user_target", (q) =>
								q.eq("userId", owner.userId).eq("target.kind", "saved").eq("target.id", nodeId),
							)
							.unique(),
					),
				);
				const states = await Promise.all(
					drafts
						.flatMap((draft) => [
							draft!.content!.baseStateId,
							draft!.content!.stagedStateId,
							draft!.content!.unstagedStateId,
						])
						.map((stateId) => ctx.db.get("files_pending_update_yjs_states", stateId)),
				);
				const pages = await Promise.all(
					states.map((state) =>
						ctx.db
							.query("files_pending_update_yjs_state_pages")
							.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state!._id))
							.collect(),
					),
				);
				return { drafts, states, pages };
			});
		const before = await read_drafts();
		for (const operation of ["Save", "Restore"] as const) {
			const places = await Promise.all(
				owners.map(async (owner) => (await f.overlay({ kind: "saved", id: nodeId }, owner)).place!),
			);
			vi.setSystemTime(Date.now() + 1000);
			const result =
				operation === "Save"
					? await f.asU.action(api.files_nodes_content.replace_file_content, {
							requestId: "changed-saved-text",
							membershipId: f.db.membershipId,
							nodeId,
							text: "Changed saved text\n",
						})
					: await f.asU.action(api.files_nodes_content.restore_snapshot_r2, {
							membershipId: f.db.membershipId,
							nodeId,
							snapshotId: snapshot!._id,
							sessionId: "saved-places-restore",
						});
			expect(result._nay).toBeUndefined();
			expect(await read_drafts(), `${operation} keeps draft IDs, moves, expiry, and all text bytes`).toEqual(before);
			expect(
				await Promise.all(owners.map(async (owner) => (await f.overlay({ kind: "saved", id: nodeId }, owner)).place!)),
				`${operation} does not rewrite another owner's place before background work`,
			).toEqual(places);
			const text = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				...f.u,
				subject: { kind: "user", userId: f.u.userId, plugin: null },
				path: "/notes.txt",
				includePending: false,
			});
			expect(text?.content, "the saved text is current before the refresh").toBe(
				operation === "Save" ? "Changed saved text\n" : "Original text\n",
			);
			expect(await saved_job(f, nodeId)).toMatchObject({ kind: "saved_places" });
			await f.settle();
			const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
			for (const [index, owner] of owners.entries())
				expect((await f.overlay({ kind: "saved", id: nodeId }, owner)).place).toMatchObject({
					updatedAt: node.updatedAt,
					ownerTreePath: `/owner-${index}.txt`,
					accessNodeId: nodeId,
				});
			expect(await read_drafts(), "background copies also keep all draft bytes").toEqual(before);
			expect(await saved_job(f, nodeId)).toBeNull();
		}
	});

	test("old metadata stays searchable until each whole place is refreshed", async () => {
		const { f, node, owners } = await metadata_fixture();
		const places = await Promise.all(
			owners.map(async (owner) => (await f.overlay({ kind: "saved", id: node._id }, owner)).place!),
		);
		const oldFields = await Promise.all(places.map((place) => fields_of(f, place._id)));
		await f.set_metadata(node.path, [
			{ key: "status", value: "new" },
			{ key: "extra", value: "added" },
		]);
		for (const [index, owner] of owners.entries()) {
			expect((await f.overlay({ kind: "saved", id: node._id }, owner)).place).toEqual(places[index]);
			expect(await fields_of(f, places[index]!._id)).toEqual(oldFields[index]);
			expect(
				(
					await test_meta_search(f.t, { ...owner, plan: { op: "eq", fieldPath: "metadata.status", value: "old" } })
				).items.map((item) => item.path),
			).toEqual([`/owner-${index}.md`]);
		}
		await test_finish_file_index(f.t, node._id);
		await f.settle();
		for (const [index, owner] of owners.entries()) {
			expect(
				(await test_meta_search(f.t, { ...owner, plan: { op: "eq", fieldPath: "metadata.status", value: "old" } }))
					.items,
			).toEqual([]);
			expect(
				(
					await test_meta_search(f.t, { ...owner, plan: { op: "eq", fieldPath: "metadata.extra", value: "added" } })
				).items.map((item) => item.path),
			).toEqual([`/owner-${index}.md`]);
			expect(await fields_of(f, places[index]!._id)).toHaveLength(4);
		}
		expect(await saved_job(f, node._id)).toBeNull();
	});

	test("later writes keep the active page and refresh every old and newly created place", async () => {
		const { f, node, owners } = await metadata_fixture(3);
		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", node._id, { updatedAt: Date.now() + 1000 }));
		expect(await saved_job(f, node._id)).toMatchObject({ fieldsChanged: false });
		// Metadata widens the queued date refresh before its first page.
		await f.set_metadata(node.path, [{ key: "status", value: "first" }]);
		await test_finish_file_index(f.t, node._id);
		expect(await saved_job(f, node._id)).toMatchObject({ fieldsChanged: true });
		await f.run_job("saved_places", node._id);
		const active = (await saved_job(f, node._id))!;
		expect(active.cursor).not.toBeNull();
		const cursor = JSON.parse(active.cursor!) as { page: string; through: number };
		await f.set_metadata(node.path, [
			{ key: "status", value: "latest" },
			{ key: "later", value: "added" },
		]);
		await test_finish_file_index(f.t, node._id);
		const requested = (await saved_job(f, node._id))!;
		expect(JSON.parse(requested.cursor!)).toMatchObject({ ...cursor, rerun: true, rerunFieldsChanged: true });
		const late = await f.t.run((ctx) => add_member(ctx, f.u, "saved_place_late"));
		await f.draft_move({ kind: "saved", id: node._id }, { kind: "root" }, "late.md", late);
		expect((await f.overlay({ kind: "saved", id: node._id }, late)).place!._creationTime).toBeGreaterThan(
			cursor.through,
		);
		await f.settle();
		for (const owner of [...owners, late]) {
			const place = (await f.overlay({ kind: "saved", id: node._id }, owner)).place!;
			const fields = await fields_of(f, place._id);
			expect(fields, "every owner reaches the complete latest field set").toHaveLength(4);
			expect(
				fields
					.filter((field) => field.docKind === "value")
					.map((field) => field.stringValue)
					.sort(),
			).toEqual(["added", "latest"]);
			expect(
				fields.every(
					(field) => field.ownerTreePath === place.ownerTreePath && field.fieldsVersion === place.fieldsVersion,
				),
			).toBe(true);
		}
		expect(await saved_job(f, node._id)).toBeNull();
	});

	test("a source change during a build keeps the old search set until the latest full set is ready", async () => {
		const { f, node, owners } = await metadata_fixture(1);
		const owner = owners[0]!;
		const before = (await f.overlay({ kind: "saved", id: node._id }, owner)).place!;
		const oldFields = await fields_of(f, before._id);
		const entries = (value: string) => [
			{ key: "status", value },
			...Array.from({ length: 80 }, (_, index) => ({ key: `field-${index}`, value: `${value}-${index}` })),
		];
		const status_paths = async (value: string) =>
			(
				await test_meta_search(f.t, {
					...owner,
					plan: { op: "eq", fieldPath: "metadata.status", value },
				})
			).items.map((item) => item.path);
		await f.set_metadata(node.path, entries("building"));
		await test_finish_file_index(f.t, node._id);
		const partial = await build_with_values(f, node._id);
		const staged = await fields_of(f, before._id);
		expect(staged.length, "the build writes a hidden field set").toBeGreaterThan(oldFields.length);
		expect(await status_paths("old")).toEqual(["/owner-0.md"]);
		const stagedValue = staged.find(
			(field) =>
				field.fieldsRefreshId !== before.fieldsRefreshId && field.docKind === "value" && field.valueKind === "string",
		);
		expect(stagedValue, "the search probes a value already written by the unfinished build").toBeDefined();
		expect(
			(
				await test_meta_search(f.t, {
					...owner,
					plan: { op: "eq", fieldPath: stagedValue!.fieldPath, value: stagedValue!.stringValue! },
				})
			).items,
			"partial metadata is not searchable",
		).toEqual([]);

		await f.set_metadata(node.path, entries("latest"));
		await test_finish_file_index(f.t, node._id);
		const requested = await saved_job(f, node._id);
		expect(requested?.kind).toBe("saved_places");
		if (!requested || requested.kind !== "saved_places") throw new Error("Expected the requested refresh");
		expect(requested.metadataRevision).toBeGreaterThan(partial.job.metadataRevision);
		expect(JSON.parse(requested.cursor!).place).toEqual(partial.cursor.place);
		const source = await f.t.run((ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", node._id)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.collect(),
		);
		const expected = source.map(field_payload).sort();
		let published = false;
		for (let step = 0; step < 100 && (await saved_job(f, node._id)); step++) {
			await f.run_job("saved_places", node._id);
			const place = (await f.overlay({ kind: "saved", id: node._id }, owner)).place!;
			const selected = (await fields_of(f, place._id)).filter(
				(field) => field.fieldsRefreshId === place.fieldsRefreshId && field.fieldsVersion === place.fieldsVersion,
			);
			published = place.fieldsRefreshId !== before.fieldsRefreshId;
			expect(selected.map(field_payload).sort(), "a build never selects a mixed or incomplete field set").toEqual(
				published ? expected : oldFields.map(field_payload).sort(),
			);
			expect(await status_paths("building"), "an abandoned source is never published").toEqual([]);
			expect(await status_paths(published ? "latest" : "old")).toEqual(["/owner-0.md"]);
		}
		expect(await saved_job(f, node._id)).toBeNull();
		expect(published, "the latest complete set becomes selected").toBe(true);
		expect(
			(await fields_of(f, before._id)).map(field_payload).sort(),
			"cleanup leaves exactly the latest fields",
		).toEqual(expected);
	});

	test("an unfinished draft field build waits for saved index publication", async () => {
		const { f, node, owners } = await metadata_fixture(1);
		const owner = owners[0]!;
		const before = (await f.overlay({ kind: "saved", id: node._id }, owner)).place!;
		const oldFields = await fields_of(f, before._id);
		const entries = (value: string) => [
			{ key: "status", value },
			...Array.from({ length: 80 }, (_, index) => ({ key: `field-${index}`, value: `${value}-${index}` })),
		];
		await f.set_metadata(node.path, entries("building"));
		await test_finish_file_index(f.t, node._id);
		await build_with_values(f, node._id);
		await f.set_metadata(node.path, entries("latest"));
		await f.t.mutation(internal.files_index.start, { nodeId: node._id });
		let paused = false;
		for (let step = 0; step < 100; step++) {
			const run = await f.t.run(async (ctx) => {
				const state = await ctx.db
					.query("files_index_states")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", node._id))
					.unique();
				return state?.activeRunId ? await ctx.db.get("files_index_runs", state.activeRunId) : null;
			});
			if (!run) throw new Error("Expected the active saved index build");
			if (run.phase === "install_text") {
				paused = true;
				break;
			}
			const args = { runId: run._id, step: run.step, generation: run.generation };
			if (run.phase === "build_metadata") await f.t.action(internal.files_index.prepare_metadata, args);
			else await f.t.mutation(internal.files_index.advance, args);
		}
		expect(paused, "the saved index has tagged all old metadata before the draft worker resumes").toBe(true);
		for (let step = 0; step < 100; step++) await f.run_job("saved_places", node._id);
		const parked = (await f.overlay({ kind: "saved", id: node._id }, owner)).place!;
		const selected = (await fields_of(f, parked._id)).filter(
			(field) => field.fieldsRefreshId === parked.fieldsRefreshId && field.fieldsVersion === parked.fieldsVersion,
		);
		expect(selected.map(field_payload).sort(), "index publication cannot select partial draft fields").toEqual(
			oldFields.map(field_payload).sort(),
		);
		await test_finish_file_index(f.t, node._id);
		await f.settle();
		const fields = await fields_of(f, before._id);
		expect(fields, "the resumed draft receives every complete latest field").toHaveLength(162);
		expect(
			fields
				.filter((field) => field.docKind === "value")
				.map((field) => field.stringValue)
				.sort(),
		).toEqual(
			entries("latest")
				.map((entry) => entry.value)
				.sort(),
		);
		expect(await saved_job(f, node._id)).toBeNull();
	});

	test("an empty metadata set becomes visible before old fields finish cleanup", async () => {
		const { f, node, owners } = await metadata_fixture(1);
		const before = (await f.overlay({ kind: "saved", id: node._id }, owners[0])).place!;
		const cleared = await f.t.mutation(internal.files_metadata.update_entries_by_path, {
			...f.u,
			path: node.path,
			set: [],
			remove: ["status"],
		});
		expect(cleared._nay).toBeUndefined();
		await test_finish_file_index(f.t, node._id);
		let sawEmptyBeforeCleanup = false;
		for (let step = 0; step < 100 && (await saved_job(f, node._id)); step++) {
			await f.run_job("saved_places", node._id);
			const place = (await f.overlay({ kind: "saved", id: node._id }, owners[0])).place!;
			const fields = await fields_of(f, place._id);
			if (place.fieldsRefreshId !== before.fieldsRefreshId) {
				expect(
					fields.filter((field) => field.fieldsRefreshId === place.fieldsRefreshId),
					"the published empty set has no selected fields",
				).toEqual([]);
				expect(
					(
						await test_meta_search(f.t, {
							...owners[0]!,
							plan: { op: "eq", fieldPath: "metadata.status", value: "old" },
						})
					).items,
				).toEqual([]);
				if (fields.length > 0) sawEmptyBeforeCleanup = true;
			}
		}
		expect(sawEmptyBeforeCleanup, "publication and old-field cleanup run separately").toBe(true);
		expect(await saved_job(f, node._id)).toBeNull();
		expect(await fields_of(f, before._id)).toEqual([]);
	});

	test("recovery refreshes surviving places without bringing a discarded move back", async () => {
		const { f, node, owners } = await metadata_fixture();
		const discardedPlace = (await f.overlay({ kind: "saved", id: node._id }, owners[0])).place!;
		await f.set_metadata(node.path, [
			{ key: "status", value: "recovered" },
			...Array.from({ length: 80 }, (_, index) => ({ key: `field-${index}`, value: `recovered-${index}` })),
		]);
		await test_finish_file_index(f.t, node._id);
		const partial = await build_with_values(f, node._id);
		expect(
			(await fields_of(f, discardedPlace._id)).length,
			"a discarded place can have a partial hidden build",
		).toBeGreaterThan(2);
		let failures = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
			if ((args as { kind: string }).kind === "saved_places" && failures++ === 0) throw new Error("test failure");
			return await handler(ctx, args);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			f.t.mutation(internal.files_pending_overlay.run_job, {
				kind: "saved_places",
				key: node._id,
				nextAttemptAt: partial.job.nextAttemptAt,
			}),
		).rejects.toThrow("test failure");
		expect(failures).toBe(1);
		expect(await saved_job(f, node._id), "failure preserves the completed build page").toMatchObject({
			attempts: 0,
			cursor: partial.job.cursor,
		});
		const proposal = await f.proposal_of({ kind: "saved", id: node._id }, f.v);
		const discarded = await f.asV.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: f.vMember.membershipId,
			target: proposal.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		expect(discarded._nay).toBeUndefined();
		vi.setSystemTime(Date.now() + 16 * 60 * 1000);
		await f.t.mutation(internal.files_pending_overlay.recover_jobs, {});
		await f.settle();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_places", discardedPlace._id))).toBeNull();
		expect(await fields_of(f, discardedPlace._id)).toEqual([]);
		expect((await f.overlay({ kind: "saved", id: node._id }, f.v)).place).toBeNull();
		const remaining = (await f.overlay({ kind: "saved", id: node._id }, owners[1])).place!;
		expect(await fields_of(f, remaining._id)).toHaveLength(162);
		expect(
			(await fields_of(f, remaining._id))
				.filter((field) => field.docKind === "value" && field.fieldPath === "metadata.status")
				.map((field) => field.stringValue),
		).toEqual(["recovered"]);
		expect(await saved_job(f, node._id)).toBeNull();
	});

	test("cleans an unfinished build after its saved node is gone", async () => {
		const { f, node, owners } = await metadata_fixture(1);
		const place = (await f.overlay({ kind: "saved", id: node._id }, owners[0])).place!;
		await f.set_metadata(node.path, [
			{ key: "status", value: "building" },
			...Array.from({ length: 80 }, (_, index) => ({ key: `field-${index}`, value: `building-${index}` })),
		]);
		await test_finish_file_index(f.t, node._id);
		await build_with_values(f, node._id);
		expect((await fields_of(f, place._id)).length).toBeGreaterThan(64);
		// Model deletion between its node removal and queued field cleanup. This is not a full purge test.
		await f.t.run((ctx) => ctx.db.delete("files_nodes", node._id));
		let runs = 0;
		for (; runs < 100 && (await saved_job(f, node._id)); runs++) await f.run_job("saved_places", node._id);
		expect(runs, "the deletion cleanup drains more than one field page").toBeGreaterThan(1);
		expect(await saved_job(f, node._id)).toBeNull();
		expect(await fields_of(f, place._id), "all selected and unfinished fields are removed").toEqual([]);
	});
});
