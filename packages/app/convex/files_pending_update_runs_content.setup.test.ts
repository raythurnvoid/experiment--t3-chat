// Fixtures shared by the files_pending_update_runs_content test files.
import { R2 } from "@convex-dev/r2";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import {
	test_convex,
	test_db_get_review_state,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_progress_guard,
} from "./setup.test.ts";
import { files_db_patch_pending_update, files_u8_to_array_buffer } from "../server/files.ts";
import { files_pending_update_runs_SELECTION_PAGE_SIZE as PAGE_SIZE } from "../server/files-pending-update-runs.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_visible_db_create_reader } from "./files_visible_db.ts";
import { r2_server_side_copy } from "./r2_client.ts";

const r2Objects = new Map<string, string | ArrayBuffer>();
let uploadDurationMs = 0;

// Each test file calls this in `beforeEach`.
export function mock_review_storage() {
	vi.useFakeTimers();
	r2Objects.clear();
	uploadDurationMs = 0;
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "review-test-upload") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
		const body = r2Objects.get(args.sourceKey);
		if (body === undefined) throw new Error("Expected source bytes");
		r2Objects.set(args.destinationKey, body);
		return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key");
			if (url.origin !== "https://r2.test" || !key) return new Response(null, { status: 404 });
			if (url.pathname === "/upload") {
				vi.setSystemTime(Date.now() + uploadDurationMs);
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) r2Objects.set(key, body);
				else if (body instanceof Uint8Array) r2Objects.set(key, files_u8_to_array_buffer(body));
				else throw new Error("Expected text or bytes in the upload");
				return new Response(null, { status: 200 });
			}
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
}

// Each upload moves the clock this far, like a slow upload.
export function set_upload_duration_ms(ms: number) {
	uploadDurationMs = ms;
}

export async function fixture(anonymous = false) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: anonymous ? null : "clerk_review_content" });
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			userId,
			organizationName: "personal",
			workspaceName: "home",
			plan: "Free",
		});
		if (anonymous) {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique();
			if (snapshot) await ctx.db.delete("billing_usage_snapshots", snapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now: Date.now() });
		}
		return membership;
	});
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity(
		anonymous
			? { issuer: process.env.VITE_CONVEX_HTTP_URL, subject: db.userId }
			: { issuer: "https://clerk.test", external_id: db.userId },
	);
	return { t, db, scope, asUser };
}

export async function stage_text(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	target: Doc<"files_pending_updates">["target"];
	operationBatchId: Id<"files_pending_update_operation_batches">;
	text: string;
	pendingUpdateId?: Id<"files_pending_updates">;
	unstagedText?: string;
}) {
	const { f, target, text, unstagedText = text, operationBatchId, pendingUpdateId } = args;

	for (const role of ["staged", "unstaged"] as const) {
		const staged = await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...f.scope,
			operationBatchId,
			role,
			text: role === "staged" ? text : unstagedText,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const ready = await f.asUser.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...f.scope,
		target,
		operationBatchId,
		pendingUpdateId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	const proposal = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", f.scope.organizationId)
					.eq("workspaceId", f.scope.workspaceId)
					.eq("userId", f.scope.userId)
					.eq("target.kind", target.kind)
					.eq("target.id", target.id),
			)
			.unique(),
	);
	if (!proposal) throw new Error("Expected the text proposal");
	return proposal;
}

export async function private_node(args: { f: Awaited<ReturnType<typeof fixture>>; path: string; text?: string }) {
	const { f, text, path } = args;

	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		path,
		kind: text === undefined ? "folder" : "file",
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private proposal");
	const { target, operationBatchId, pendingUpdateId } = created._yay;
	if (text !== undefined) {
		if (!operationBatchId) throw new Error("Expected the text batch");
		return await stage_text({ f, target, operationBatchId, text, pendingUpdateId });
	}
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!proposal) throw new Error("Expected the folder proposal");
	return proposal;
}

export async function start_review(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	proposals: Doc<"files_pending_updates">[];
	selected?: "staged" | "unstaged";
}) {
	const { f, proposals, selected = "unstaged" } = args;

	const items = proposals.map((proposal) => ({
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
		selectedContentStateId:
			(selected === "staged" ? proposal.content?.stagedStateId : proposal.content?.unstagedStateId) ?? null,
	}));
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: proposals.length,
		items: items.slice(0, PAGE_SIZE),
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	for (let offset = PAGE_SIZE; offset < items.length; offset += PAGE_SIZE)
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.append_items, {
				membershipId: f.db.membershipId,
				runId,
				offset,
				items: items.slice(offset, offset + PAGE_SIZE),
			}),
		).toEqual({ _yay: null });
	expect(
		await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
	).toEqual({ _yay: null });
	const progress = test_progress_guard();
	for (let pass = 0; pass < 50_000; pass++) {
		const state = await f.t.run((ctx) => test_db_get_review_state(ctx, runId));
		const { job } = state;
		progress(state, `Review planning, job ${job?.kind ?? "none"}`);
		if (job) {
			await f.t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
			continue;
		}
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (run?.step !== "planning") return runId;
	}
	throw new Error("Review planning did not finish");
}

export async function finish_review(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	runId: Id<"files_pending_update_runs">;
	stepMs?: number;
}) {
	const { f, runId, stepMs = 0 } = args;

	if (stepMs) vi.setSystemTime(Date.now() + stepMs);
	await test_finish_pending_update_run(f.asUser, runId);
	return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
}

export async function saved_text(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">) {
	return await f.t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", nodeId);
		if (!node?.yjsSnapshotId) throw new Error("Expected the saved Yjs snapshot");
		const snapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
		if (!snapshot) throw new Error("Expected the snapshot");
		const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
		const bytes = asset?.r2Key ? r2Objects.get(asset.r2Key) : null;
		if (!(bytes instanceof ArrayBuffer)) throw new Error("Expected snapshot bytes");
		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId).eq("fileNodeId", nodeId),
			)
			.order("asc")
			.collect();
		const yjsDoc = files_yjs_doc_create_from_array_buffer_update(bytes, {
			additionalIncrementalArrayBufferUpdates: updates
				.filter((update) => update.sequence > snapshot.sequence)
				.map((update) => update.update),
		});
		const text = files_yjs_doc_get_text({ yjsDoc, rootKind: node.textKind ?? "plain_text" });
		if (text._nay) throw new Error(text._nay.message);
		return text._yay;
	});
}

export async function private_media(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	path: string;
	sourceId?: Id<"files_nodes">;
}) {
	const { f, path, sourceId } = args;

	await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: f.scope.userId, plan: "Pay As You Go" }));
	const prepared = await f.t.mutation(internal.files_ingestion.prepare_file, {
		...f.scope,
		membershipId: f.db.membershipId,
		requestId: path,
		attemptId: "review-media",
		path,
		size: 4,
		contentType: "image/png",
		digest: "a".repeat(64),
		content: { kind: "stored" },
	});
	if (prepared._nay) throw new Error(prepared._nay.message);
	if (prepared._yay.kind !== "stored") throw new Error("Expected the media upload");
	r2Objects.set(prepared._yay.r2Key, new Uint8Array([1, 2, 3, 4]).buffer);
	const ready = await f.t.mutation(internal.files_ingestion.finalize_file, {
		...f.scope,
		membershipId: f.db.membershipId,
		receiptId: prepared._yay.receiptId,
		attemptId: "review-media",
	});
	if (ready._nay || ready._yay.target.kind !== "private") throw new Error("Expected the private media");
	return await f.t.run(async (ctx) => {
		const reader = await files_visible_db_create_reader(ctx, f.scope);
		const entry = await reader.resolveTarget(ready._yay.target);
		if (entry?.kind !== "private") throw new Error("Expected the media proposal");
		if (sourceId)
			await files_db_patch_pending_update({
				ctx,
				pendingUpdateId: entry.pendingUpdate._id,
				value: {
					copiedFrom: { target: { kind: "saved", id: sourceId }, path: "/source", sourceWritePolicy: null },
				},
			});
		return {
			pending: (await ctx.db.get("files_pending_updates", entry.pendingUpdate._id))!,
			src: files_media_build_private_src(entry.node._id),
		};
	});
}

/**
 * Mark a document as a Copy of `sourceId`, so review links its media in copy mode.
 */
export async function mark_copied(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	pending: Doc<"files_pending_updates">;
	sourceId: Id<"files_nodes">;
}) {
	const { f, pending, sourceId } = args;

	return await f.t.run(async (ctx) => {
		await files_db_patch_pending_update({
			ctx,
			pendingUpdateId: pending._id,
			value: {
				copiedFrom: { target: { kind: "saved", id: sourceId }, path: "/source", sourceWritePolicy: null },
			},
		});
		return (await ctx.db.get("files_pending_updates", pending._id))!;
	});
}

/**
 * Accept a Copy document with `mediaCount` Copy media. Each media is its own unit, and the document waits
 * for all of them. The test files pick a count past one review page.
 */
export async function save_copy_media_before_document(mediaCount: number) {
	const f = await fixture();
	const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/source" });
	if (source._nay) throw new Error(source._nay.message);
	const images = [];
	for (let index = 0; index < mediaCount; index++)
		images.push(await private_media({ f, path: `/image-${index}.png`, sourceId: source._yay.nodeId }));
	const text = images.map(({ src }) => `![Image](${src})`).join("\n\n") + "\n";
	const document = await mark_copied({
		f,
		pending: await private_node({ f, path: "/document.md", text }),
		sourceId: source._yay.nodeId,
	});
	const runId = await start_review({ f, proposals: [document, ...images.map(({ pending }) => pending)] });
	const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
	expect(units).toHaveLength(mediaCount + 1);
	expect(units.every((unit) => unit.kind === "cohort" && unit.itemCount === 1)).toBe(true);
	expect(units.find((unit) => unit.order === 0)).toMatchObject({
		status: "waiting",
		remainingPrerequisiteCount: mediaCount,
	});
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect())).toHaveLength(
		mediaCount,
	);
	const result = await finish_review({ f, runId, stepMs: 1_200 });
	expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: mediaCount + 1 } });
	const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
	expect(saved).toHaveLength(mediaCount + 2);
	expect(await saved_text(f, saved.find((node) => node.path === "/document.md")!._id)).toBe(text);
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(
		mediaCount + 1,
	);
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	const documentUnit = await f.t.run((ctx) =>
		ctx.db.get("files_pending_update_run_units", units.find((unit) => unit.order === 0)!._id),
	);
	if (!documentUnit?.cohortId) throw new Error("Expected the completed document group");
	const content = await f.t.run((ctx) =>
		ctx.db
			.query("files_move_cohort_content")
			.withIndex("by_cohort_proposal", (q) =>
				q.eq("cohortId", documentUnit.cohortId!).eq("pendingUpdateId", document._id),
			)
			.unique(),
	);
	expect(content?.mediaProof).toMatchObject({
		reviewedRevision: document.revision,
		selectedContentStateId: document.content?.unstagedStateId,
		expectedCount: mediaCount,
		validatedCount: mediaCount,
		sealed: true,
	});
}
