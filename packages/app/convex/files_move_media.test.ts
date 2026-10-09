import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import { files_move_media_db_validate_next } from "./files_move_media.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_saved_placement_db_resolve_read_target } from "../server/files-saved-placement.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";

const objects = new Map<string, string | ArrayBuffer>();

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
			const key = parsed.searchParams.get("key")!;
			if (parsed.pathname === "/upload") {
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(imageCount = 1) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			userId: await ctx.db.insert("users", { clerkUserId: "cohort-media" }),
			plan: "Pay As You Go",
		}),
	);
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const images: Doc<"files_pending_updates">[] = [];
	for (let index = 0; index < imageCount; index++) {
		const uploaded = await t.mutation(internal.files_ingestion.prepare_file, {
			...scope,
			membershipId: db.membershipId,
			requestId: `image-${index}`,
			attemptId: `image-${index}`,
			path: `/image-${index}.png`,
			size: 4,
			contentType: "image/png",
			digest: "a".repeat(64),
			content: { kind: "stored" },
		});
		if (uploaded._nay || uploaded._yay.kind !== "stored") throw new Error("Expected stored media");
		objects.set(uploaded._yay.r2Key, new Uint8Array([1, 2, 3, 4]).buffer);
		const finalized = await t.mutation(internal.files_ingestion.finalize_file, {
			...scope,
			membershipId: db.membershipId,
			receiptId: uploaded._yay.receiptId,
			attemptId: `image-${index}`,
		});
		if (finalized._nay || finalized._yay.target.kind !== "private") throw new Error("Expected private media");
		const image = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", finalized._yay.target.id),
				)
				.unique(),
		);
		if (!image || image.target.kind !== "private") throw new Error("Expected the media proposal");
		images.push(image);
	}
	const image = images[0]!;
	if (image.target.kind !== "private") throw new Error("Expected private media");
	const src = files_media_build_private_src(image.target.id);
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path: "/document.md",
		kind: "file",
	});
	if (created._nay || !created._yay.operationBatchId || !created._yay.pendingUpdateId)
		throw new Error("Expected a text draft");
	const text = images
		.map((image) => {
			if (image.target.kind !== "private") throw new Error("Expected private media");
			return `![private media](${files_media_build_private_src(image.target.id)})`;
		})
		.join("\n\n");
	for (const role of ["staged", "unstaged"] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId: created._yay.operationBatchId,
			role,
			text,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const edited = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...scope,
		target: created._yay.target,
		pendingUpdateId: created._yay.pendingUpdateId,
		operationBatchId: created._yay.operationBatchId,
	});
	if (edited._nay) throw new Error(edited._nay.message);
	const document = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
	if (!document) throw new Error("Expected the document proposal");
	expect(document.mediaDependencySetId, "ordinary rich text has no Copy mapping").toBeUndefined();
	return { t, db, scope, asUser, image, images, document, src, text };
}

async function stage_review(f: Awaited<ReturnType<typeof fixture>>, phase: "ready" | "validating" = "ready") {
	const selected = [f.document, ...f.images];
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: "media-review",
		kind: "accept",
		expectedItemCount: selected.length,
		items: selected.map((proposal) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: proposal.content?.stagedStateId ?? null,
		})),
	});
	if (started._nay) throw new Error(started._nay.message);
	await f.asUser.mutation(api.files_pending_update_runs.seal, {
		membershipId: f.db.membershipId,
		runId: started._yay.runId,
	});
	for (let pass = 0; pass < 100; pass++) {
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) =>
					q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
				)
				.first(),
		);
		if (job)
			await f.t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
		else await f.t.action(internal.files_pending_update_runs.plan, { runId: started._yay.runId, fence: 0 });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", started._yay.runId));
		if (run?.step === "running") break;
		if (pass === 99) throw new Error("Media review did not plan");
	}
	const units = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_update_run_units")
			.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
			.collect(),
	);
	expect(
		units.map((unit) => unit.itemCount),
		"actual ordinary embeds join their selected private media",
	).toEqual([selected.length]);
	const unit = units[0]!;
	await f.t.mutation(internal.files_pending_update_runs.advance, { runId: started._yay.runId });
	const begun = await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", unit!._id));
	if (!begun?.cohortId) throw new Error("Expected the review cohort");
	let cohort: Doc<"files_move_cohorts"> | null = null;
	for (let pass = 0; pass < 2_000; pass++) {
		cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", begun.cohortId!));
		if (!cohort) throw new Error("Expected the cohort");
		if (cohort.phase === phase) return cohort;
		if (cohort.phase === "aborting" || cohort.phase === "complete")
			throw new Error(`Media staging stopped: ${cohort.errorCode}: ${cohort.errorMessage}`);
		await f.t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
	}
	throw new Error(`Media staging did not finish: ${cohort?.phase}/${cohort?.workPhase}`);
}

test("proves actual prepared private embeds through the native AFTER receipt", async () => {
	const f = await fixture();
	const cohort = await stage_review(f);
	const content = await f.t.run((ctx) =>
		ctx.db
			.query("files_move_cohort_content")
			.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", cohort._id).eq("pendingUpdateId", f.document._id))
			.unique(),
	);
	if (!content?.preparedMediaSet || !content.acceptedTextInputId) throw new Error("Expected prepared document media");
	expect(content.mediaProof, "the actual prepared embed is proved before publication").toMatchObject({
		expectedCount: 1,
		validatedCount: 1,
		sealed: true,
	});
	expect(
		(
			await f.t.run((ctx) => ctx.db.get("files_pending_update_text_inputs", content.acceptedTextInputId!))
		)?.text.trimEnd(),
	).toBe(f.text);
	const saved = await f.t.run((ctx) =>
		files_saved_placement_db_resolve_read_target(
			ctx.db,
			{ ...f.scope, target: f.image.target },
			{ cohortId: cohort._id, view: "after" },
		),
	);
	expect(saved?.kind, "a private embed resolves through its staged receipt").toBe("saved");
	const proof = await test_run_with_flush(f.t, (ctx) =>
		files_move_media_db_validate_next(ctx, {
			cohortId: cohort._id,
			contentId: content._id,
			proofEpoch: cohort.proofEpoch,
			cursor: null,
		}),
	);
	expect(proof._yay?.done).toBe(true);
}, 120_000);

test("refuses a selected media candidate after its asset hold is lost", async () => {
	const f = await fixture();
	const cohort = await stage_review(f, "validating");
	const content = await f.t.run((ctx) =>
		ctx.db
			.query("files_move_cohort_content")
			.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", cohort._id).eq("pendingUpdateId", f.document._id))
			.unique(),
	);
	const image = await f.t.run((ctx) =>
		ctx.db
			.query("files_move_cohort_content")
			.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", cohort._id).eq("pendingUpdateId", f.image._id))
			.unique(),
	);
	if (!content?.preparedMediaSet || !image?.afterAssetId) throw new Error("Expected staged document and media");
	await f.t.run(async (ctx) => {
		const hold = await ctx.db
			.query("files_private_storage_reservations")
			.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", image.afterAssetId!))
			.unique();
		expect(hold?.settlement.kind).toBe("held");
		// Inject a lost hold after real staging. The final proof must still refuse it.
		await ctx.db.delete("files_private_storage_reservations", hold!._id);
	});
	const proof = await test_run_with_flush(f.t, (ctx) =>
		files_move_media_db_validate_next(ctx, {
			cohortId: cohort._id,
			contentId: content._id,
			proofEpoch: cohort.proofEpoch,
			cursor: null,
		}),
	);
	expect(proof._nay?.name, "a selected media candidate without its asset hold cannot be proved").toBe("needs_review");
	expect((await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", content._id)))?.mediaProof).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", cohort._id))).toMatchObject({
		visibleView: "before",
		publishedAt: null,
	});
}, 120_000);

test.each([false, true])(
	"checks fresh membership on each prepared media page (reinvited: %s)",
	async (reinvited) => {
		const f = await fixture(9);
		const cohort = await stage_review(f, "validating");
		const content = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", cohort._id).eq("pendingUpdateId", f.document._id))
				.unique(),
		);
		if (!content?.preparedMediaSet) throw new Error("Expected prepared document media");
		const validate = (cursor: string | null) =>
			test_run_with_flush(f.t, async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await files_move_media_db_validate_next(ctx, {
					cohortId: cohort._id,
					contentId: content._id,
					proofEpoch: cohort.proofEpoch,
					cursor,
				});
				await files_pending_overlay_db_flush(ctx);
				const after = await ctx.meta.getTransactionMetrics();
				const cost = {
					databaseQueries: after.databaseQueries.used - before.databaseQueries.used,
					documentsRead: after.documentsRead.used - before.documentsRead.used,
					bytesRead: after.bytesRead.used - before.bytesRead.used,
					documentsWritten: after.documentsWritten.used - before.documentsWritten.used,
					bytesWritten: after.bytesWritten.used - before.bytesWritten.used,
				};
				return { result, cost };
			});
		const first = await validate(null);
		expect(first.result._yay?.done, "nine refs need a second native page").toBe(false);
		expect((await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", content._id)))?.mediaProof).toMatchObject({
			expectedCount: 9,
			validatedCount: 8,
			sealed: false,
		});
		if (reinvited)
			await f.t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					...f.scope,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				const membership = await ctx.db.get("organizations_workspaces_users", membershipId);
				if (!membership) throw new Error("Expected the new membership");
				expect(await organizations_membership_lifetimes_db_ensure(ctx, membership)).toBe(2);
			});
		const second = await validate(first.result._yay!.cursor);
		if (reinvited) {
			expect(second.result._nay?.name, "a later page refuses the replaced membership").toBe("permission_denied");
			expect((await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", content._id)))?.mediaProof).toMatchObject({
				validatedCount: 8,
				sealed: false,
			});
		} else {
			expect(second.result._yay?.done, "all prepared refs are proved before sealing").toBe(true);
			expect((await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", content._id)))?.mediaProof).toMatchObject({
				validatedCount: 9,
				sealed: true,
			});
		}
		console.info("Prepared media validation, with flush", { reinvited, first: first.cost, second: second.cost });
	},
	120_000,
);
