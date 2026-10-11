import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_drain_billing_usage_event_outbox, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_transfer_db_get_entry_version } from "./files_transfer.ts";
import { files_pending_updates_action_prepare_content } from "./files_pending_updates.ts";
import {
	files_pending_media_db_require_validation,
	files_pending_media_db_validate_prepared,
	type files_pending_media_ValidatedSave,
} from "./files_pending_media.ts";
import {
	files_media_dependencies_db_create,
	files_media_dependencies_db_append,
	files_media_dependencies_db_seal,
} from "./files_media_dependencies.ts";
import { files_media_build_file_src } from "../shared/files-media.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_saved_placement_db_resolve_read_target } from "../server/files-saved-placement.ts";
import {
	mock_media_storage,
	fixture,
	proposal,
	private_text,
	saved_proposal,
	media,
	attach_dependencies,
	dependencies,
	save,
	document_proposal,
	saved_doc,
	bulk_save,
	copy_replacement,
} from "./files_pending_media_save.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("paged Save media proof", () => {
	test("checks more than one page, refuses stale pins, and rebuilds after a media Save", async () => {
		const f = await fixture();
		const images: Awaited<ReturnType<typeof media>>[] = [];
		for (let index = 0; index < 26; index++) images.push(await media(f, `/photo-${index}.png`));
		const text = images.map((image) => `![Photo](${image.dependency.src})`).join("\n\n") + "\n";
		let pending = await private_text(f, { staged: text });
		// Seed only the set link for this proof test. Media and text use real doors.
		await f.t.run(async (ctx) => {
			const set = await files_media_dependencies_db_create(ctx, {
				...f.scope,
				owner: { kind: "proposal", pendingUpdateId: pending._id },
				expectedCount: images.length,
			});
			if (set._nay) throw new Error(set._nay.message);
			expect(
				await files_media_dependencies_db_append(ctx, {
					setId: set._yay,
					generation: 0,
					offset: 0,
					mappings: images.map((image) => ({ sourceSrc: image.dependency.src, dependency: image.dependency })),
				}),
			).toEqual({ _yay: null });
			expect(await files_media_dependencies_db_seal(ctx, { setId: set._yay, generation: 0 })).toEqual({ _yay: null });
			await ctx.db.patch("files_pending_updates", pending._id, { mediaDependencySetId: set._yay });
		});
		pending = await proposal(f, pending.target);
		const prepared = await f.t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: f.scope.userId,
				membershipId: f.membershipId,
				target: pending.target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
				reviewedPrivateParentIds: [],
			}),
		);
		if (prepared._nay) throw new Error(prepared._nay.message);
		const operationBatchId = prepared._yay.operationBatchIds[0]!;
		const args = {
			userId: f.scope.userId,
			operationBatchId,
			reviewedPendingUpdateIds: images.map((image) => image.pending._id),
		};
		const readInput = async () =>
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_update_text_inputs")
					.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", operationBatchId))
					.first(),
			);
		const check = async (acceptedText = text, reviewed = new Set(args.reviewedPendingUpdateIds)) =>
			await f.t.run((ctx) =>
				files_pending_media_db_require_validation(ctx, {
					pendingUpdate: pending,
					text: acceptedText,
					operationBatchId,
					reviewedPendingUpdateIds: reviewed,
				}),
			);
		expect(await check()).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_pending_media.start_validation, {
				...args,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: { isDone: false } });
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toEqual({
			_yay: { isDone: false },
		});
		expect((await readInput())?.mediaValidation).toMatchObject({ validatedCount: 25, totalCount: 26 });
		expect(await check()).toHaveProperty("_nay");
		const savedImage = await save(f, images[0]!.pending);
		if (savedImage._nay) throw new Error(savedImage._nay.message);
		if (savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const savedImageId = savedImage._yay.target.id;
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toMatchObject({
			_nay: { name: "media_validation_changed" },
		});
		expect((await readInput())?.mediaValidation?.validatedCount).toBe(25);
		expect(
			await f.t.mutation(internal.files_pending_media.start_validation, {
				...args,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: { isDone: false } });
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toEqual({
			_yay: { isDone: false },
		});
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toEqual({
			_yay: { isDone: true },
		});
		expect(await check()).toEqual({ _yay: null });
		expect(await check(text + "Changed\n")).toHaveProperty("_nay");
		expect(await check(text, new Set())).toHaveProperty("_nay");
		const nextImage = images[1]!.pending;
		let validated: files_pending_media_ValidatedSave | undefined;
		await f.t.run(async (ctx) => {
			const proof = await files_pending_media_db_validate_prepared(ctx, {
				userId: f.scope.userId,
				prepared: prepared._yay,
				reviewedPendingUpdateIds: new Set(args.reviewedPendingUpdateIds),
			});
			if (proof._nay || !proof._yay) throw new Error("Expected a checked media proof");
			validated = proof._yay;
			expect(
				await files_pending_media_db_require_validation(ctx, {
					pendingUpdate: pending,
					text,
					operationBatchId,
					reviewedPendingUpdateIds: new Set(args.reviewedPendingUpdateIds),
					validated,
				}),
			).toEqual({ _yay: null });
		});
		const published = await save(f, nextImage);
		if (published._nay) throw new Error(published._nay.message);
		expect(published._yay.target.kind).toBe("saved");
		// A proof checked in another mutation cannot skip the changed clock.
		expect(
			await f.t.run((ctx) =>
				files_pending_media_db_require_validation(ctx, {
					pendingUpdate: pending,
					text,
					operationBatchId,
					reviewedPendingUpdateIds: new Set(args.reviewedPendingUpdateIds),
					validated,
				}),
			),
		).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_pending_media.start_validation, {
				...args,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: { isDone: false } });
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toEqual({
			_yay: { isDone: false },
		});
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toEqual({
			_yay: { isDone: true },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedImageId))).not.toBeNull();
		expect(
			await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.membershipId,
				nodeId: savedImageId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedImageId))).toMatchObject({
			writePolicy: { mode: "read_only" },
		});
		expect(await check()).toMatchObject({ _nay: { name: "media_validation_changed" } });
	});

	test("checks a new merged private embed even when it was not in the copied set", async () => {
		const f = await fixture();
		const image = await media(f);
		const text = `![Merged](${image.dependency.src})\n`;
		let pending = await private_text(f, { staged: text });
		await f.t.run(async (ctx) => {
			const set = await files_media_dependencies_db_create(ctx, {
				...f.scope,
				owner: { kind: "proposal", pendingUpdateId: pending._id },
				expectedCount: 0,
			});
			if (set._nay) throw new Error(set._nay.message);
			await files_media_dependencies_db_seal(ctx, { setId: set._yay, generation: 0 });
			await ctx.db.patch("files_pending_updates", pending._id, { mediaDependencySetId: set._yay });
		});
		pending = await proposal(f, pending.target);
		const prepared = await f.t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: f.scope.userId,
				membershipId: f.membershipId,
				target: pending.target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
				reviewedPrivateParentIds: [],
			}),
		);
		if (prepared._nay) throw new Error(prepared._nay.message);
		const args = {
			userId: f.scope.userId,
			operationBatchId: prepared._yay.operationBatchIds[0]!,
			reviewedPendingUpdateIds: [],
		};
		expect(
			await f.t.mutation(internal.files_pending_media.start_validation, {
				...args,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: { isDone: false } });
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, args)).toHaveProperty("_nay");
		const selected = { ...args, reviewedPendingUpdateIds: [image.pending._id] };
		expect(
			await f.t.mutation(internal.files_pending_media.start_validation, {
				...selected,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: { isDone: false } });
		expect(await f.t.mutation(internal.files_pending_media.advance_validation, selected)).toEqual({
			_yay: { isDone: true },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test("accepts a no-media Save proof after an unrelated clock change", async () => {
		const f = await fixture();
		const text = "No media\n";
		let pending = await private_text(f, { staged: text });
		// Without a media set, Save skips the proof. Give it an empty one, like a copy with no embeds.
		await f.t.run(async (ctx) => {
			const set = await files_media_dependencies_db_create(ctx, {
				...f.scope,
				owner: { kind: "proposal", pendingUpdateId: pending._id },
				expectedCount: 0,
			});
			if (set._nay) throw new Error(set._nay.message);
			await files_media_dependencies_db_seal(ctx, { setId: set._yay, generation: 0 });
			await ctx.db.patch("files_pending_updates", pending._id, { mediaDependencySetId: set._yay });
		});
		pending = await proposal(f, pending.target);
		const prepared = await f.t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: f.scope.userId,
				membershipId: f.membershipId,
				target: pending.target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
				reviewedPrivateParentIds: [],
			}),
		);
		if (prepared._nay) throw new Error(prepared._nay.message);
		const operationBatchId = prepared._yay.operationBatchIds[0]!;
		expect(
			await f.t.mutation(internal.files_pending_media.start_validation, {
				userId: f.scope.userId,
				operationBatchId,
				reviewedPendingUpdateIds: [],
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: { isDone: true } });
		// A proof with no media refs has nothing a later Files or access change can break.
		await f.t.run(async (ctx) => {
			for (const clock of await ctx.db.query("files_media_validation_versions").collect())
				await ctx.db.patch("files_media_validation_versions", clock._id, { revision: clock.revision + 1 });
			for (const clock of await ctx.db.query("files_content_versions").collect())
				await ctx.db.patch("files_content_versions", clock._id, { revision: clock.revision + 1 });
			for (const clock of await ctx.db.query("files_pending_review_versions").collect())
				await ctx.db.patch("files_pending_review_versions", clock._id, { revision: clock.revision + 1 });
		});
		expect(
			await f.t.run((ctx) =>
				files_pending_media_db_require_validation(ctx, {
					pendingUpdate: pending,
					text,
					operationBatchId,
					reviewedPendingUpdateIds: new Set(),
				}),
			),
		).toEqual({ _yay: null });
	});
});

describe("Save ordinary rich-text media", () => {
	test.each([false, true])(
		"ordinary Save keeps broken and unselected links (selected media: %s)",
		async (selectMedia) => {
			const f = await fixture();
			const unselected = await media(f, "/unselected.png");
			const image = await media(f, "/selected.png");
			// Put ignored links before the selected one, across more than one media page.
			const refs = [
				...Array.from({ length: 9 }, (_, index) => files_media_build_file_src(`missing-${index}`)),
				unselected.dependency.src,
				image.dependency.src,
			];
			const text = `Intro\n\n${refs.map((src) => `![Photo](${src})`).join("\n\n")}\n`;
			const pending = await private_text(f, { staged: text });
			expect(pending.mediaDependencySetId).toBeUndefined();
			const result = await bulk_save({ f, selected: [pending, ...(selectMedia ? [image.pending] : [])] });
			expect(result?.activity, "ordinary Save keeps broken and unselected links as text").toMatchObject({
				status: "succeeded",
				progress: { completed: selectMedia ? 2 : 1, blocked: 0 },
			});
			const target = await f.t.run((ctx) =>
				files_saved_placement_db_resolve_read_target(ctx.db, { ...f.scope, target: pending.target }),
			);
			if (target?.kind !== "saved") throw new Error("Expected saved document");
			const after = await saved_doc(f, target.id);
			expect(files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })._yay).toBe(text);
			after.destroy();
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
			expect(await proposal(f, unselected.pending.target)).toEqual(unselected.pending);
			if (selectMedia)
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", image.pending._id))).toBeNull();
			else expect(await proposal(f, image.pending.target)).toEqual(image.pending);
		},
	);

	test.each([true, false])(
		"ordinary Save checks a live embed added after planning (media selected: %s)",
		async (selectMedia) => {
			const f = await fixture();
			const text = "Intro\n\nFooter\n";
			const saved = await save(f, await private_text(f, { staged: text, collaborative: true }));
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved document");
			const nodeId = saved._yay.target.id;
			const accepted = "Changed\n\nFooter\n";
			const pending = await saved_proposal({ f, target: saved._yay.target, staged: accepted });
			expect(pending.mediaDependencySetId).toBeUndefined();
			const image = await media(f);
			const liveAppend = `\n![Live](${image.dependency.src})\n`;
			const result = await bulk_save({
				f,
				selected: [pending, ...(selectMedia ? [image.pending] : [])],
				afterPlan: async () => {
					// This link is absent from the graph. The document still has a one-item group.
					const before = await saved_doc(f, nodeId);
					const edited = files_yjs_doc_clone({ yjsDoc: before });
					expect(
						files_yjs_doc_update_from_text({ mut_yjsDoc: edited, rootKind: "rich_text", text: text + liveAppend })._nay,
					).toBeUndefined();
					const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
					if (!update) throw new Error("Expected live append");
					const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
					expect(
						(
							await f.asUser.mutation(api.files_nodes.yjs_push_update, {
								membershipId: f.membershipId,
								nodeId,
								expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
								update: files_u8_to_array_buffer(update),
								sessionId: "ordinary-live-media-after-plan",
							})
						)._nay,
					).toBeUndefined();
					before.destroy();
					edited.destroy();
					expect(await proposal(f, pending.target)).toEqual(pending);
				},
			});
			const after = await saved_doc(f, nodeId);
			const finalText = files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })._yay;
			after.destroy();
			if (selectMedia) {
				expect(
					result?.activity.progress?.completed,
					"late selected ordinary media keeps the document unpublished",
				).toBeLessThan(2);
				const unit = await f.t.run(async (ctx) => {
					const item = await ctx.db
						.query("files_pending_update_run_items")
						.withIndex("by_run_pendingUpdate", (q) =>
							q.eq("runId", result!.run._id).eq("pendingUpdateId", pending._id),
						)
						.unique();
					return await ctx.db.get("files_pending_update_run_units", item!.unitId!);
				});
				expect(unit, "late selected ordinary media reaches the strict media check").toMatchObject({
					status: "blocked",
					itemCount: 1,
					errorCode: "needs_review",
					errorMessage: "A linked media file changed. Review this document again.",
				});
				expect(await proposal(f, pending.target)).toEqual(pending);
				expect(finalText).toBe(text + liveAppend);
			} else {
				expect(result?.activity, "ordinary Save keeps a live unselected media link as text").toMatchObject({
					status: "succeeded",
					progress: { completed: 1, blocked: 0 },
				});
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
				expect(finalText).toBe(accepted + liveAppend);
				expect(await proposal(f, image.pending.target)).toEqual(image.pending);
			}
		},
	);
});

describe("Save copied rich-text media", () => {
	test.each(["private", "yjs", "asset"] as const)(
		"%s refuses unsaved media without changing the proposal or saved file",
		async (kind) => {
			const f = await fixture();
			const image = await media(f);
			const text = `Before\n\n![Photo](${image.dependency.src})\n\nAfter\n`;
			const pending = await attach_dependencies({
				f,
				pending: await document_proposal({ f, kind, staged: text }),
				dependencies: [image.dependency],
			});
			const target = pending.target;
			const before = target.kind === "saved" ? await f.t.run((ctx) => ctx.db.get("files_nodes", target.id)) : null;
			const beforeDoc = kind === "yjs" && target.kind === "saved" ? await saved_doc(f, target.id) : null;
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			const billingCalls = () =>
				enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events").length;
			await test_drain_billing_usage_event_outbox(f.t);
			const billedBefore = billingCalls();
			expect(await save(f, pending)).toMatchObject({
				_nay: { message: expect.stringContaining("Save the selected media") },
			});
			const refusedRun =
				target.kind === "private"
					? await f.t.run((ctx) =>
							ctx.db
								.query("files_pending_update_runs")
								.withIndex("by_user_requestId", (q) =>
									q
										.eq("userId", f.scope.userId)
										.eq("requestId", `single-save:${f.membershipId}:${target.id}:${pending._id}:${pending.revision}`),
								)
								.unique(),
						)
					: null;
			await test_drain_billing_usage_event_outbox(f.t);
			expect(billingCalls()).toBe(billedBefore);
			expect(await proposal(f, pending.target)).toEqual(pending);
			if (target.kind === "saved") {
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toEqual(before);
				if (beforeDoc) {
					const afterDoc = await saved_doc(f, target.id);
					expect(files_yjs_doc_get_text({ yjsDoc: afterDoc, rootKind: "rich_text" })).toEqual(
						files_yjs_doc_get_text({ yjsDoc: beforeDoc, rootKind: "rich_text" }),
					);
					afterDoc.destroy();
					beforeDoc.destroy();
				}
			} else {
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({ state: "active" });
			}
			// The same document succeeds once the exact media is saved.
			expect((await save(f, image.pending))._nay).toBeUndefined();
			expect(
				(await save(f, pending))._nay,
				"a new Save retries the refused review after its media is saved",
			).toBeUndefined();
			if (refusedRun) {
				const base = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", refusedRun._id));
				expect(
					base?.singleSaveLatestRunId,
					"the base request points directly at the new deliberate attempt",
				).toBeDefined();
				expect(base?.singleSaveLatestRunId).not.toBe(refusedRun._id);
			}
			await test_drain_billing_usage_event_outbox(f.t);
			expect(billingCalls()).toBeGreaterThan(billedBefore);
		},
	);

	test.each(["private", "yjs", "asset"] as const)(
		"%s bulk Save accepts the document before its selected media",
		async (kind) => {
			const f = await fixture();
			const image = await media(f);
			const pending = await attach_dependencies({
				f,
				pending: await document_proposal({ f, kind, staged: `![Photo](${image.dependency.src})\n` }),
				dependencies: [image.dependency],
			});
			const result = await bulk_save({ f, selected: [pending, image.pending] });
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", image.pending._id))).toBeNull();
		},
	);

	test("bulk refusal rolls back media published earlier in the same unit", async () => {
		const f = await fixture();
		const selected = await media(f);
		const unselected = await media(f, "/clip.mp4");
		const text = `![Photo](${selected.dependency.src})\n\n<video src="${unselected.dependency.src}" controls></video>\n`;
		const pending = await attach_dependencies({
			f,
			pending: await private_text(f, { staged: text }),
			dependencies: [selected.dependency, unselected.dependency],
		});
		const result = await bulk_save({ f, selected: [selected.pending, pending] });
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 2 } });
		for (const original of [selected.pending, pending, unselected.pending]) {
			expect(await proposal(f, original.target)).toEqual(original);
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", selected.dependency.target.id))).toMatchObject({
			state: "active",
		});
	});

	test.each(["private", "yjs", "asset"] as const)(
		"%s partial Save keeps the dependency for the later Save",
		async (kind) => {
			const f = await fixture();
			const image = await media(f);
			const accepted = "Accepted\n";
			const remaining = `${accepted}\n![Photo](${image.dependency.src})\n`;
			const pending = await attach_dependencies({
				f,
				pending: await document_proposal({ f, kind, staged: accepted, unstaged: remaining }),
				dependencies: [image.dependency],
			});
			const first = await save(f, pending);
			if (first._nay) throw new Error(first._nay.message);
			const partial = await proposal(f, first._yay.target);
			expect(await dependencies(f, partial)).toEqual([image.dependency]);
			const second = await saved_proposal({ f, target: partial.target, staged: remaining });
			expect(await dependencies(f, second)).toEqual([image.dependency]);
			expect(await save(f, second)).toMatchObject({
				_nay: { message: expect.stringContaining("Save the selected media") },
			});
			expect(await proposal(f, second.target)).toEqual(second);
		},
	);

	test.each(["yjs", "asset"] as const)(
		"%s Save with no accepted change leaves the media dependency pending",
		async (kind) => {
			const f = await fixture();
			const image = await media(f);
			const base = "Before\n\nMiddle\n\nAfter\n";
			const pending = await attach_dependencies({
				f,
				pending: await document_proposal({
					f,
					kind,
					staged: base,
					unstaged: `${base}\n![Photo](${image.dependency.src})\n`,
				}),
				dependencies: [image.dependency],
			});
			const saved = await save(f, pending);
			if (saved._nay) throw new Error(saved._nay.message);
			expect(await dependencies(f, await proposal(f, saved._yay.target))).toEqual([image.dependency]);
			expect(await proposal(f, image.pending.target)).toEqual(image.pending);
		},
	);

	test("Yjs checks accepted text merged with a live embed absent from the staged branch", async () => {
		const f = await fixture();
		const image = await media(f);
		const pending = await attach_dependencies({
			f,
			pending: await document_proposal({ f, kind: "yjs", staged: "BEFORE\n\nMiddle\n\nAfter\n" }),
			dependencies: [image.dependency],
		});
		if (pending.target.kind !== "saved") throw new Error("Expected saved document");
		const nodeId = pending.target.id;
		const before = await saved_doc(f, nodeId);
		const edited = files_yjs_doc_clone({ yjsDoc: before });
		expect(
			files_yjs_doc_update_from_text({
				mut_yjsDoc: edited,
				rootKind: "rich_text",
				text: `Before\n\nMiddle\n\n![Live](${image.dependency.src})\n`,
			})._nay,
		).toBeUndefined();
		const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
		if (!update) throw new Error("Expected live edit");
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		expect(
			(
				await f.asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: f.membershipId,
					nodeId,
					expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
					update: files_u8_to_array_buffer(update),
					sessionId: "live-media",
				})
			)._nay,
		).toBeUndefined();
		const liveText = files_yjs_doc_get_text({ yjsDoc: edited, rootKind: "rich_text" });
		before.destroy();
		edited.destroy();
		expect(await save(f, pending)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		const after = await saved_doc(f, nodeId);
		expect(files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })).toEqual(liveText);
		after.destroy();
	});

	test("code, links, and external media do not keep a removed embed dependency", async () => {
		const f = await fixture();
		const image = await media(f);
		const text = `\`\`\`text\n![code](${image.dependency.src})\n\`\`\`\n\n[link](${image.dependency.src})\n\n![External](https://example.test/photo.png)\n`;
		const pending = await attach_dependencies({
			f,
			pending: await private_text(f, { staged: text }),
			dependencies: [image.dependency],
		});
		expect((await save(f, pending))._nay).toBeUndefined();
		expect(await proposal(f, image.pending.target)).toEqual(image.pending);
	});

	test("a saved private alias joins its new media delete and refuses the whole review unit", async () => {
		const f = await fixture();
		const image = await media(f);
		const saved = await save(f, image.pending);
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const target = saved._yay.target;
		const pending = await attach_dependencies({
			f,
			pending: await private_text(f, { staged: `![Photo](${image.dependency.src})\n` }),
			dependencies: [image.dependency],
		});
		expect(
			(await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...f.scope, target }))
				._nay,
		).toBeUndefined();
		const archive = await proposal(f, target);
		expect(archive._id).not.toBe(image.pending._id);
		expect(await save(f, pending)).toMatchObject({
			_nay: { message: "The reviewed media is no longer available." },
		});
		expect((await bulk_save({ f, selected: [pending, archive] }))?.activity).toMatchObject({
			status: "failed",
			progress: { completed: 0, blocked: 2 },
		});
		expect(await proposal(f, pending.target)).toEqual(pending);
		expect(await proposal(f, target)).toEqual(archive);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toMatchObject({
			assetId: image.dependency.assetId,
			archiveOperationId: null,
		});
	});

	test.each([false, true])(
		"a saved private alias joins the new media replacement (expects replacement: %s)",
		async (expectsReplacement) => {
			const f = await fixture();
			const image = await media(f);
			const saved = await save(f, image.pending);
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const target = saved._yay.target;
			const source = await media(f, "/new.png");
			const replacement = await copy_replacement({ f, source: source.pending.target, targetName: "photo.png" });
			expect(replacement._id).not.toBe(image.pending._id);
			if (!replacement.pendingReplacement) throw new Error("Expected media replacement");
			const version = await f.t.run(async (ctx) => {
				const entry = await (await files_visible_db_create_reader(ctx, f.scope)).resolveTarget(target);
				if (!entry) throw new Error("Expected replacement media");
				return await files_transfer_db_get_entry_version(ctx, entry);
			});
			if (!version) throw new Error("Expected a replacement version");
			const dependency = expectsReplacement
				? { ...image.dependency, assetId: replacement.pendingReplacement.assetId, version }
				: image.dependency;
			const pending = await attach_dependencies({
				f,
				pending: await private_text(f, { staged: `![Photo](${dependency.src})\n` }),
				dependencies: [dependency],
			});
			const result = await bulk_save({ f, selected: [pending, replacement] });
			if (expectsReplacement) {
				expect(result?.activity, result?.errors).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toMatchObject({
					assetId: dependency.assetId,
				});
			} else {
				expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 2 } });
				expect(await proposal(f, pending.target)).toEqual(pending);
				expect(await proposal(f, target)).toEqual(replacement);
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toMatchObject({
					assetId: image.dependency.assetId,
				});
			}
		},
	);

	test("a replacement document accepts media selected in the same Save unit", async () => {
		const f = await fixture();
		const image = await media(f);
		const saved = await save(f, await private_text(f, { staged: "Old document\n" }));
		if (saved._nay) throw new Error(saved._nay.message);
		const source = await private_text(f, { path: "/source.md", staged: `![Photo](${image.dependency.src})\n` });
		const replacement = await attach_dependencies({
			f,
			pending: await copy_replacement({ f, source: source.target, targetName: "document.md" }),
			dependencies: [image.dependency],
		});
		expect(await save(f, replacement)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		const result = await bulk_save({ f, selected: [replacement, image.pending] });
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
	});
});

describe("Save near a draft move into a folder the member can no longer read", () => {
	/**
	 * A second member of the workspace, with the member role. The fixture user is the owner.
	 */
	async function member(f: Awaited<ReturnType<typeof fixture>>) {
		const v = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "media-save-member" });
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, { ...f.scope, userId, role: "member", now: Date.now() });
			return { userId, membershipId };
		});
		return {
			...f,
			membershipId: v.membershipId,
			scope: { ...f.scope, userId: v.userId },
			asUser: f.t.withIdentity({ issuer: "https://clerk.test", external_id: v.userId }),
		};
	}

	async function saved_folder(f: Awaited<ReturnType<typeof fixture>>, path: string) {
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			path,
			kind: "folder",
		});
		if (created._nay) throw new Error(created._nay.message);
		const saved = await save(f, await proposal(f, created._yay.target));
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved folder");
		return saved._yay.target;
	}

	/**
	 * The owner saves an image. The member links to the saved file.
	 */
	async function saved_media(
		f: Awaited<ReturnType<typeof fixture>>,
		v: Awaited<ReturnType<typeof member>>,
		path: string,
	) {
		const image = await media(f, path);
		const saved = await save(f, image.pending);
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const target = saved._yay.target;
		const version = await f.t.run(async (ctx) => {
			const entry = await (await files_visible_db_create_reader(ctx, v.scope)).resolveTarget(target);
			if (!entry) throw new Error("Expected readable media");
			return await files_transfer_db_get_entry_version(ctx, entry);
		});
		if (!version) throw new Error("Expected a media version");
		return { src: files_media_build_file_src(target.id), target, assetId: image.dependency.assetId, version };
	}

	/**
	 * The member drafts `mv /proj /team/`, then the owner restricts /team without sharing it.
	 */
	async function block_proj(
		f: Awaited<ReturnType<typeof fixture>>,
		v: Awaited<ReturnType<typeof member>>,
		folders: { proj: { id: Id<"files_nodes"> }; team: { id: Id<"files_nodes"> } },
	) {
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...v.scope,
			target: { kind: "saved", id: folders.proj.id },
			destParent: { kind: "saved", id: folders.team.id },
			destName: "proj",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const restricted = await f.asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: f.membershipId,
			nodeId: folders.team.id,
		});
		if (restricted._nay) throw new Error(restricted._nay.message);
	}

	test("a document inside the blocked moved folder still saves its media links", async () => {
		const f = await fixture();
		const v = await member(f);
		const proj = await saved_folder(f, "/proj");
		const team = await saved_folder(f, "/team");
		const doc = await save(f, await private_text(f, { path: "/proj/plan.md", staged: "Plan\n" }));
		if (doc._nay) throw new Error(doc._nay.message);
		const image = await saved_media(f, v, "/photo.png");
		const pending = await attach_dependencies({
			f: v,
			pending: await saved_proposal({ f: v, target: doc._yay.target, staged: `Plan\n\n![Photo](${image.src})\n` }),
			dependencies: [image],
		});
		await block_proj(f, v, { proj, team });

		// The document has no move of its own, so its row keeps Accept on.
		expect(
			await v.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: v.membershipId,
				target: pending.target,
			}),
		).toMatchObject({ entry: { path: "/proj/plan.md" }, canAccept: true, moveDestinationUnreadable: false });
		expect((await save(v, pending))._nay).toBeUndefined();
	});

	// A private document goes through the review plan's media check. A saved document's content Save
	// also checks each link again.
	test.each(["private", "saved"] as const)(
		"a %s document elsewhere still saves a link to media inside the blocked moved folder",
		async (kind) => {
			const f = await fixture();
			const v = await member(f);
			const proj = await saved_folder(f, "/proj");
			const team = await saved_folder(f, "/team");
			const image = await saved_media(f, v, "/proj/photo.png");
			const text = `![Photo](${image.src})\n`;
			let document: Doc<"files_pending_updates">;
			if (kind === "private") document = await private_text(v, { staged: text });
			else {
				const saved = await save(f, await private_text(f, { staged: "Doc\n" }));
				if (saved._nay) throw new Error(saved._nay.message);
				document = await saved_proposal({ f: v, target: saved._yay.target, staged: text });
			}
			const pending = await attach_dependencies({ f: v, pending: document, dependencies: [image] });
			await block_proj(f, v, { proj, team });

			expect((await save(v, pending))._nay).toBeUndefined();
		},
	);
});
