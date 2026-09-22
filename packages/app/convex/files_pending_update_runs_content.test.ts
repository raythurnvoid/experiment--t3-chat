import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_db_patch_pending_update, files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_transfer_db_get_entry_version } from "./files_transfer.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import {
	files_media_dependencies_db_create,
	files_media_dependencies_db_append,
	files_media_dependencies_db_seal,
} from "./files_media_dependencies.ts";

const r2Objects = new Map<string, string | ArrayBuffer>();
let uploadDurationMs = 0;

beforeEach(() => {
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
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(anonymous = false) {
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

async function stage_text(
	f: Awaited<ReturnType<typeof fixture>>,
	target: Doc<"files_pending_updates">["target"],
	operationBatchId: Id<"files_pending_update_operation_batches">,
	text: string,
	pendingUpdateId?: Id<"files_pending_updates">,
	unstagedText = text,
) {
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

async function private_node(f: Awaited<ReturnType<typeof fixture>>, path: string, text?: string) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		path,
		kind: text === undefined ? "folder" : "file",
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private proposal");
	const { target, operationBatchId, pendingUpdateId } = created._yay;
	if (text !== undefined) {
		if (!operationBatchId) throw new Error("Expected the text batch");
		return await stage_text(f, target, operationBatchId, text, pendingUpdateId);
	}
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!proposal) throw new Error("Expected the folder proposal");
	return proposal;
}

async function start_review(
	f: Awaited<ReturnType<typeof fixture>>,
	proposals: Doc<"files_pending_updates">[],
	selected: "staged" | "unstaged" = "unstaged",
) {
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
		items: items.slice(0, 100),
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	for (let offset = 100; offset < items.length; offset += 100)
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.append_items, {
				membershipId: f.db.membershipId,
				runId,
				offset,
				items: items.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	expect(
		await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 100; pass++) {
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (run?.step !== "planning") break;
		if (pass === 99) throw new Error("Review planning did not finish");
	}
	return runId;
}

async function finish_review(
	f: Awaited<ReturnType<typeof fixture>>,
	runId: Id<"files_pending_update_runs">,
	stepMs = 0,
) {
	for (let pass = 0; pass < 1_000; pass++) {
		if (stepMs) vi.setSystemTime(Date.now() + stepMs);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished")
			return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		if (!unit) continue;
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
	}
	throw new Error("Review did not finish");
}

async function saved_text(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">) {
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

async function private_media(f: Awaited<ReturnType<typeof fixture>>, path: string, sourceId?: Id<"files_nodes">) {
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
	const assetId = prepared._yay.assetId;
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
			await files_db_patch_pending_update(ctx, entry.pendingUpdate._id, {
				copiedFrom: { target: { kind: "saved", id: sourceId }, path: "/source", sourceWritePolicy: null },
			});
		const pending = (await ctx.db.get("files_pending_updates", entry.pendingUpdate._id))!;
		const version = await files_transfer_db_get_entry_version(ctx, { ...entry, pendingUpdate: pending });
		if (!version) throw new Error("Expected the ready media version");
		return {
			pending,
			dependency: {
				src: files_media_build_private_src(entry.node._id),
				target: pending.target,
				assetId,
				version,
			},
		};
	});
}

async function attach_media(
	f: Awaited<ReturnType<typeof fixture>>,
	pending: Doc<"files_pending_updates">,
	images: Awaited<ReturnType<typeof private_media>>[],
	sourceId?: Id<"files_nodes">,
) {
	const set = await f.t.run((ctx) =>
		files_media_dependencies_db_create(ctx, {
			...f.scope,
			owner: { kind: "proposal", pendingUpdateId: pending._id },
			expectedCount: images.length,
		}),
	);
	if (set._nay) throw new Error(set._nay.message);
	for (let offset = 0; offset < images.length; offset += 50)
		expect(
			await f.t.run((ctx) =>
				files_media_dependencies_db_append(ctx, {
					setId: set._yay,
					generation: 0,
					offset,
					mappings: images
						.slice(offset, offset + 50)
						.map(({ dependency }) => ({ sourceSrc: dependency.src, dependency })),
				}),
			),
		).toEqual({ _yay: null });
	return await f.t.run(async (ctx) => {
		expect(await files_media_dependencies_db_seal(ctx, { setId: set._yay, generation: 0 })).toEqual({ _yay: null });
		// Only the captured mapping is seeded; text and media use their normal producer doors.
		await files_db_patch_pending_update(ctx, pending._id, {
			mediaDependencySetId: set._yay,
			...(sourceId
				? { copiedFrom: { target: { kind: "saved" as const, id: sourceId }, path: "/source", sourceWritePolicy: null } }
				: {}),
		});
		return (await ctx.db.get("files_pending_updates", pending._id))!;
	});
}

describe("review job content", () => {
	test("rebinds only the exact partial Save remainder hold to its published target", async () => {
		const f = await fixture();
		const draft = await private_node(f, "/partial.txt", "initial\n");
		const other = await private_node(f, "/other");
		const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: f.db.membershipId,
			target: draft.target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const partial = await stage_text(
			f,
			draft.target,
			batch._yay.operationBatchId,
			"selected\n",
			draft._id,
			"remainder\n",
		);
		const runId = await start_review(f, [partial, other], "staged");
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		expect(unit?.status).toBe("preparing");
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: 0,
			unitId: unit!._id,
			attemptFence: unit!.attemptFence,
		});
		const remainder = await f.t.run((ctx) => ctx.db.get("files_pending_updates", partial._id));
		expect(remainder).toMatchObject({ target: { kind: "saved" }, revision: partial.revision + 1 });
		if (remainder?.target.kind !== "saved") throw new Error("Expected the saved remainder");
		expect(await saved_text(f, remainder.target.id)).toBe("selected\n");
		const hold = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_holds")
				.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", remainder._id))
				.unique(),
		);
		expect(hold).toMatchObject({
			target: remainder.target,
			privateGeneration: null,
			role: "review",
			producer: { id: runId },
		});
		vi.setSystemTime(Date.now() + 10 * 60 * 1000);
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		await f.t.mutation(internal.files_pending_holds.release_producer, {
			producer: { kind: "files_pending_update_run", id: runId },
		});
		const task = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates_cleanup_tasks")
				.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", remainder._id))
				.unique(),
		);
		expect(task?.expiresAt).toBe(result!.activity.finishedAt! + 4 * 60 * 60 * 1000);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", remainder._id))).toEqual(remainder);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(2);
	});

	test("saves independent Copy replacements separately with exact target IDs and one charge each", async () => {
		const f = await fixture();
		const initial = [];
		for (const root of ["source", "target"]) {
			initial.push(await private_node(f, `/${root}`));
			for (const name of ["a", "b"]) initial.push(await private_node(f, `/${root}/${name}.txt`, `${root} ${name}\n`));
		}
		expect((await finish_review(f, await start_review(f, initial)))?.activity.status).toBe("succeeded");
		const before = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const parent = before.find((node) => node.path === "/target")!;
		const sources = before
			.filter((node) => node.path.startsWith("/source/"))
			.map((node) => ({ kind: "saved" as const, id: node._id }));
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "copy-replacements",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const copied = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.db.membershipId,
			threadId: thread._yay.threadId,
			requestId: "copy-replacements",
			kind: "copy",
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			expectedSourceCount: 2,
			sources,
			targetParent: { kind: "saved", id: parent._id },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (copied._nay) throw new Error(copied._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.db.membershipId,
				threadId: thread._yay.threadId,
				runId: copied._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let pass = 0; pass < 100; pass++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: copied._yay.runId });
			const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
			for (const item of items.filter((item) => item.state === "copying")) {
				if (!item.workId) throw new Error("Expected the Copy worker");
				await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
				await f.t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
			}
			const activity = await f.t.run((ctx) => ctx.db.get("activities", copied._yay.activityId));
			if (activity?.status === "succeeded") break;
			if (pass === 99) throw new Error(`Copy did not finish: ${activity?.status}`);
		}
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(proposals).toHaveLength(2);
		expect(
			proposals.every(
				(proposal) => proposal.target.kind === "saved" && proposal.copiedFrom && proposal.pendingReplacement,
			),
		).toBe(true);
		for (const name of ["a", "b"])
			expect(await saved_text(f, before.find((node) => node.path === `/target/${name}.txt`)!._id)).toBe(
				`target ${name}\n`,
			);
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const runId = await start_review(f, proposals);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_update_run_units")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			),
		).toMatchObject([
			{ kind: "copy", itemCount: 1 },
			{ kind: "copy", itemCount: 1 },
		]);
		expect((await finish_review(f, runId))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 2 },
		});
		for (const name of ["a", "b"]) {
			const destination = before.find((node) => node.path === `/target/${name}.txt`)!;
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", destination._id))).toMatchObject({
				path: destination.path,
				archiveOperationId: null,
			});
			expect(await saved_text(f, destination._id)).toBe(`source ${name}\n`);
			expect(await saved_text(f, before.find((node) => node.path === `/source/${name}.txt`)!._id)).toBe(
				`source ${name}\n`,
			);
		}
		const billing = () => enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
		expect(billing()).toHaveLength(2);
		const units = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		for (const unit of units)
			await f.t.action(internal.files_pending_update_runs.prepare_unit, {
				runId,
				fence: 0,
				unitId: unit._id,
				attemptFence: unit.attemptFence - 1,
			});
		expect(billing()).toHaveLength(2);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node._id)).toEqual(
			before.map((node) => node._id),
		);
	});

	test.each([false, true])(
		"plans an embed added through public edits after Copy (captured media: %s)",
		async (hasCapturedMedia) => {
			const f = await fixture();
			const oldImage = hasCapturedMedia ? await private_media(f, "/old-image.png") : null;
			const sourceText = oldImage ? `Before\n\n![Old image](${oldImage.dependency.src})\n` : "Before\n";
			const source = await private_node(f, "/source.md", sourceText);
			const destination = await private_node(f, "/destination");
			expect(
				(await finish_review(f, await start_review(f, [...(oldImage ? [oldImage.pending] : []), source, destination])))
					?.activity.status,
			).toBe("succeeded");
			const before = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const sourceId = before.find((node) => node.path === "/source.md")!._id;
			const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
				membershipId: f.db.membershipId,
				clientGeneratedId: "edited-copy-media",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const sourceIds = [sourceId, ...(oldImage ? [before.find((node) => node.path === "/old-image.png")!._id] : [])];
			const copied = await f.t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: f.db.membershipId,
				threadId: thread._yay.threadId,
				requestId: "edited-copy-media",
				kind: "copy",
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				expectedSourceCount: sourceIds.length,
			sources: sourceIds.map((id) => ({ kind: "saved" as const, id })),
				targetParent: { kind: "saved", id: before.find((node) => node.path === "/destination")!._id },
				targetPath: "/destination",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (copied._nay) throw new Error(copied._nay.message);
			expect(
				await f.t.mutation(internal.files_transfer.seal_for_agent, {
					membershipId: f.db.membershipId,
					threadId: thread._yay.threadId,
					runId: copied._yay.runId,
				}),
			).toEqual({ _yay: null });
			for (let pass = 0; pass < 100; pass++) {
				await f.t.mutation(internal.files_transfer.advance, { runId: copied._yay.runId });
				const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
				for (const item of items.filter((item) => item.state === "copying")) {
					if (!item.workId) throw new Error("Expected the Copy worker");
					await f.t.action(internal.files_nodes_content.copy_transfer_file, {
						itemId: item._id,
						attempt: item.attempt,
					});
					await f.t.mutation(internal.files_transfer.handle_copy_complete, {
						workId: item.workId,
						context: { itemId: item._id, attempt: item.attempt },
						result: { kind: "success", returnValue: null },
					});
				}
				const activity = await f.t.run((ctx) => ctx.db.get("activities", copied._yay.activityId));
				if (activity?.status === "succeeded") break;
				if (pass === 99) throw new Error(`Copy did not finish: ${activity?.status}`);
			}
			const copiedProposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			const document = copiedProposals.find((proposal) => proposal.copiedFrom?.target.id === sourceId);
			if (!document?.copiedFrom) throw new Error("Expected the copied document");
			if (!document.mediaDependencySetId) throw new Error("Expected the copied document's dependency set");
			expect(
				await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", document.mediaDependencySetId!)),
			).toMatchObject({ count: hasCapturedMedia ? 1 : 0, sealed: true });
			const image = await private_media(f, "/new-image.png");
			const text = `Before\n\n![New image](${image.dependency.src})\n`;
			const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
				membershipId: f.db.membershipId,
				target: document.target,
			});
			if (batch._nay) throw new Error(batch._nay.message);
			for (const role of ["staged", "unstaged"] as const) {
				const staged = await f.asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
					membershipId: f.db.membershipId,
					operationBatchId: batch._yay.operationBatchId,
					role,
					text,
				});
				if (staged._nay) throw new Error(staged._nay.message);
			}
			const edited = await f.asUser.action(api.files_pending_updates.upsert_file_pending_update, {
				membershipId: f.db.membershipId,
				target: document.target,
				operationBatchId: batch._yay.operationBatchId,
				pendingUpdateId: document._id,
				reviewedRevision: document.revision,
			});
			if (edited._nay || !edited._yay.pendingUpdate) throw new Error("Expected the edited Copy");
			const current = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", document._id)))!;
			expect(current.revision).toBeGreaterThan(document.revision);
			expect(current.mediaDependencySetId).toBe(document.mediaDependencySetId);
			const runId = await start_review(f, [current, image.pending]);
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(await saved_text(f, saved.find((node) => node.path === "/destination/source.md")!._id)).toBe(text);
			expect(await saved_text(f, sourceId)).toBe(sourceText);
			expect(saved.find((node) => node.path === "/new-image.png")).toMatchObject({ kind: "file" });
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(
				copiedProposals.filter((proposal) => proposal._id !== document._id),
			);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(
				hasCapturedMedia ? 5 : 4,
			);
		},
	);

	test("saves more than 200 Copy media before its document and keeps one unit per output", async () => {
		const f = await fixture();
		const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/source" });
		if (source._nay) throw new Error(source._nay.message);
		const images = [];
		for (let index = 0; index < 201; index++)
			images.push(await private_media(f, `/image-${index}.png`, source._yay.nodeId));
		const text = images.map(({ dependency }) => `![Image](${dependency.src})`).join("\n\n") + "\n";
		const document = await attach_media(f, await private_node(f, "/document.md", text), images, source._yay.nodeId);
		const runId = await start_review(f, [document, ...images.map(({ pending }) => pending)]);
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units).toHaveLength(202);
		expect(units.every((unit) => unit.kind === "copy" && unit.itemCount === 1)).toBe(true);
		expect(units.find((unit) => unit.order === 0)).toMatchObject({
			status: "waiting",
			remainingPrerequisiteCount: 201,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect())).toHaveLength(201);
		const result = await finish_review(f, runId, 1_200);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 202 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved).toHaveLength(203);
		expect(await saved_text(f, saved.find((node) => node.path === "/document.md")!._id)).toBe(text);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(202);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		const proof = await f.t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect());
		expect(
			proof.some(
				(input) => input.mediaValidation?.validatedCount === 201 && input.mediaValidation.reviewRunId === runId,
			),
		).toBe(true);
	});

	test("resumes the exact reviewed-embed cursor without adding duplicate prerequisites", async () => {
		const f = await fixture();
		const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/source" });
		if (source._nay) throw new Error(source._nay.message);
		const images = [];
		for (let index = 0; index < 9; index++)
			images.push(await private_media(f, `/image-${index}.png`, source._yay.nodeId));
		const text = images.map(({ dependency }) => `![Image](${dependency.src})`).join("\n\n") + "\n";
		const document = await attach_media(f, await private_node(f, "/document.md", text), [], source._yay.nodeId);
		const proposals = [document, ...images.map(({ pending }) => pending)];
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: "dependency-page-replay",
			kind: "accept",
			expectedItemCount: proposals.length,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content?.unstagedStateId ?? null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
		).toEqual({ _yay: null });
		for (let pass = 0; pass < 2; pass++)
			expect(
				(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._nay,
			).toBeUndefined();
		expect(
			await f.t.mutation(internal.files_pending_update_runs.advance_atomic_plan, {
				runId,
				fence: 0,
				cursor: null,
				nextCursor: null,
				promoteIds: [],
				done: true,
			}),
		).toEqual({ _yay: null });
		for (let pass = 0; pass < 2; pass++)
			expect(
				(await f.t.mutation(internal.files_pending_update_runs.stage_copy_units_page, { runId, fence: 0 }))._nay,
			).toBeUndefined();
		const page = await f.t.query(internal.files_pending_update_runs.get_dependency_plan_page, { runId, fence: 0 });
		if (page._nay || !page._yay.item) throw new Error("Expected the document dependency page");
		if (!page._yay.run.plan) throw new Error("Expected the review plan");
		const unitId = page._yay.item.unitId;
		if (!unitId) throw new Error("Expected the document unit");
		const args = {
			runId,
			fence: 0,
			cursor: page._yay.run.plan.cursor,
			dependencyCursor: null,
			itemId: page._yay.item._id,
			mediaRefs: images.slice(0, 8).map(({ dependency }) => dependency.src),
			isDone: false,
			error: null,
		};
		expect(await f.t.mutation(internal.files_pending_update_runs.stage_dependency_plan_page, args)).toEqual({
			_yay: null,
		});
		const before = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		expect(before?.plan).toMatchObject({ phase: "dependencies", itemId: args.itemId, dependencyCursor: "8" });
		expect(await f.t.mutation(internal.files_pending_update_runs.stage_dependency_plan_page, args)).toMatchObject({
			_nay: { name: "stopped" },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect())).toHaveLength(8);
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
			fence: 1,
			plan: before!.plan,
		});
		expect(await f.t.mutation(internal.files_pending_update_runs.stage_dependency_plan_page, args)).toMatchObject({
			_nay: { name: "stopped" },
		});
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 1 });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
			step: "running",
			plan: { phase: "ready", dependencyCursor: null },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect())).toHaveLength(9);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", unitId))).toMatchObject(
			{ remainingPrerequisiteCount: 9, status: "waiting" },
		);
		expect((await finish_review(f, runId, 1_200))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 10 },
		});
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved).toHaveLength(11);
		expect(await saved_text(f, saved.find((node) => node.path === "/document.md")!._id)).toBe(text);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(10);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("blocks a document after its selected media changes but saves an unrelated Copy", async () => {
		const f = await fixture();
		const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/source" });
		if (source._nay) throw new Error(source._nay.message);
		const image = await private_media(f, "/photo.png", source._yay.nodeId);
		const text = `![Image](${image.dependency.src})\n`;
		const document = await attach_media(f, await private_node(f, "/document.md", text), [image], source._yay.nodeId);
		const unrelated = await private_node(f, "/unrelated.txt", "keep this Copy\n");
		const other = await f.t.run(async (ctx) => {
			await files_db_patch_pending_update(ctx, unrelated._id, {
				copiedFrom: { target: { kind: "saved", id: source._yay.nodeId }, path: "/source", sourceWritePolicy: null },
			});
			return (await ctx.db.get("files_pending_updates", unrelated._id))!;
		});
		const runId = await start_review(f, [document, image.pending, other]);
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: image.pending.target,
					destParent: { kind: "root" },
					destName: "changed.png",
				})
			)._nay,
		).toBeUndefined();
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 1, blocked: 2 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/source", "/unrelated.txt"]);
		expect(await saved_text(f, saved.find((node) => node.path === "/unrelated.txt")!._id)).toBe("keep this Copy\n");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", document._id))).toEqual(document);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", image.pending._id))).toMatchObject({
			revision: image.pending.revision + 1,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(1);
	});

	test("checks both media proofs before an atomic parent and two documents change the clocks", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/parent");
		const image = await private_media(f, "/parent/photo.png");
		const text = `![Image](${image.dependency.src})\n`;
		const first = await attach_media(f, await private_node(f, "/parent/first.md", text), [image]);
		const second = await attach_media(f, await private_node(f, "/parent/second.md", text), [image]);
		const runId = await start_review(f, [first, second, image.pending, parent]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ kind: "atomic", itemCount: 4 },
		]);
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 4 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved).toHaveLength(4);
		for (const name of ["first", "second"])
			expect(await saved_text(f, saved.find((node) => node.path === `/parent/${name}.md`)!._id)).toBe(text);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(4);
	});

	test.each([false, true])("checks the total connected Save cost (anonymous: %s)", async (anonymous) => {
		const f = await fixture(anonymous);
		const parent = await private_node(f, "/parent");
		const first = await private_node(f, "/parent/first.txt", "first\n");
		const second = await private_node(f, "/parent/second.txt", "second\n");
		const proposals = [parent, first, second];
		await f.t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
				.unique();
			if (!snapshot?.meter) throw new Error("Expected the Free balance");
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, { meter: { ...snapshot.meter, balance: 1 } });
		});
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const result = await finish_review(f, await start_review(f, proposals));
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 3 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
		expect(enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")).toEqual([]);
		const failedUnit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique());
		await f.t.mutation(internal.files_pending_update_runs.retire_unit_preparation, { unitId: failedUnit!._id });
		await f.t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
				.unique();
			expect(snapshot?.meter?.balance).toBe(1);
			await ctx.db.patch("billing_usage_snapshots", snapshot!._id, { meter: { ...snapshot!.meter!, balance: 2 } });
		});
		const retry = await finish_review(f, await start_review(f, proposals));
		expect(retry?.activity).toMatchObject({ status: "succeeded", progress: { completed: 3 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/parent", "/parent/first.txt", "/parent/second.txt"]);
		for (const name of ["first", "second"])
			expect(await saved_text(f, saved.find((node) => node.name === `${name}.txt`)!._id)).toBe(`${name}\n`);
		const balance = await f.t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
				.unique(),
		);
		expect(balance?.meter?.balance).toBe(anonymous ? 0 : 2);
		expect(enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")).toHaveLength(
			anonymous ? 0 : 2,
		);
	});

	test("publishes private text before archiving its selected saved parent", async () => {
		const f = await fixture();
		const parentId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				createdBy: f.scope.userId,
				updatedBy: f.scope.userId,
				parentId: "root",
				name: "parent",
				path: "/parent",
				treePath: "/parent/",
			}),
		);
		const child = await private_node(f, "/parent/child.txt", "reviewed child\n");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: parentId },
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const result = await finish_review(f, await start_review(f, proposals));
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run.unitCount).toBe(1);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/parent", "/parent/child.txt"]);
		expect(saved.every((node) => node.archiveOperationId !== null)).toBe(true);
		expect(await saved_text(f, saved.find((node) => node.path.endsWith(".txt"))!._id)).toBe("reviewed child\n");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child._id))).toBeNull();
	});

	test("keeps saved child content and its selected parent move in one unit", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/parent");
		const child = await private_node(f, "/parent/child.txt", "before\n");
		expect((await finish_review(f, await start_review(f, [parent, child])))?.activity.status).toBe("succeeded");
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const savedParent = saved.find((node) => node.kind === "folder")!;
		const savedChild = saved.find((node) => node.kind === "file")!;
		const target = { kind: "saved", id: savedChild._id } as const;
		const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: f.db.membershipId,
			target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const edited = await stage_text(f, target, batch._yay.operationBatchId, "after\n");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: savedParent._id },
					destParent: { kind: "root" },
					destName: "moved",
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const result = await finish_review(
			f,
			await start_review(f, [edited, ...proposals.filter((proposal) => proposal._id !== edited._id)]),
		);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run.unitCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedChild._id))).toMatchObject({
			path: "/moved/child.txt",
			parentId: savedParent._id,
		});
		expect(await saved_text(f, savedChild._id)).toBe("after\n");
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("publishes mixed private folders and text in parent order", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/parent");
		const nested = await private_node(f, "/parent/nested");
		const sibling = await private_node(f, "/parent/sibling.txt", "sibling\n");
		const child = await private_node(f, "/parent/nested/child.txt", "child\n");
		const result = await finish_review(f, await start_review(f, [child, sibling, nested, parent]));
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 4 } });
		expect(result?.run.unitCount).toBe(1);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual([
			"/parent",
			"/parent/nested",
			"/parent/nested/child.txt",
			"/parent/sibling.txt",
		]);
		for (const node of saved.filter((node) => node.kind === "file"))
			expect(await saved_text(f, node._id)).toBe(node.name === "child.txt" ? "child\n" : "sibling\n");
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(4);
	});

	test.each([false, true])(
		"saves text above private storage caps and settles its holds (anonymous: %s)",
		async (anonymous) => {
			const f = await fixture(anonymous);
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			const proposal = await private_node(f, "/draft.txt", "selected content\n");
			const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			await f.t.run(async (ctx) => {
				for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
					const id = await quotas_db_ensure(ctx, { ...f.scope, quotaName, now: Date.now() });
					await ctx.db.patch("quotas", id, { maxCount: 0 });
				}
			});
			const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
				membershipId: f.db.membershipId,
				target: proposal.target,
			});
			if (batch._nay) throw new Error(batch._nay.message);
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
						...f.scope,
						operationBatchId: batch._yay.operationBatchId,
						role: "unstaged",
						text: "extra bytes",
					})
				)._nay?.name,
			).toBe("storage_full");
			await f.t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: batch._yay.operationBatchId,
			});
			const runId = await start_review(f, [proposal]);
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").unique());
			if (!saved) throw new Error("Expected the saved text");
			expect(await saved_text(f, saved._id)).toBe("selected content\n");
			const item = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").unique());
			const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			const publicationHolds = holds.filter((hold) => hold.publicationBatchId);
			expect(publicationHolds.length).toBeGreaterThan(0);
			expect(publicationHolds.reduce((total, hold) => total + hold.byteCount, 0)).toBeLessThanOrEqual(20 * 1024 * 1024);
			for (const hold of publicationHolds) expect(item?.prepared?.operationBatchIds).toContain(hold.publicationBatchId);
			const savedAssets = publicationHolds.filter((hold) => hold.resource.kind === "asset");
			expect(savedAssets.length).toBeGreaterThan(0);
			for (const hold of savedAssets) expect(hold.settlement).toMatchObject({ kind: "saved", savedNodeId: saved._id });
			const quotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
			for (const quota of quotas.filter(
				(quota) =>
					quota.quotaName === "files_private_user_bytes" || quota.quotaName === "files_private_workspace_bytes",
			)) {
				const heldBytes = holds
					.filter(
						(hold) =>
							hold.settlement.kind === "held" &&
							hold.resource.kind !== "node" &&
							(hold.userQuotaId === quota._id || hold.workspaceQuotaId === quota._id),
					)
					.reduce((total, hold) => total + hold.byteCount, 0);
				expect(quota.usedCount).toBe(heldBytes);
			}
			const billingCalls = enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
			const afterBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			if (anonymous) {
				expect(billingCalls).toHaveLength(0);
				expect(afterBilling?.meter?.consumedUnits).toBe(beforeBilling!.meter!.consumedUnits + 1);
				expect(afterBilling?.meter?.balance).toBe(beforeBilling!.meter!.balance - 1);
			} else {
				expect(billingCalls).toHaveLength(1);
				expect(billingCalls[0]![2]).toMatchObject({
					events: [{ name: "file_save", metadata: { amount: 1, nodeId: saved._id } }],
				});
				expect(afterBilling).toEqual(beforeBilling);
				const index = enqueue.mock.calls.indexOf(billingCalls[0]!);
				const workId = await enqueue.mock.results[index]!.value;
				expect(
					await f.t.query((ctx) => new Workpool(components.billing_workpool_usage_event, {}).status(ctx, workId)),
				).toMatchObject({ state: "pending" });
			}
		},
	);

	test("keeps failed preparation bytes held when a connected unit fills the 20 MiB allowance", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/full");
		const children = [];
		const text = "x".repeat(files_MAX_TEXT_CONTENT_BYTES);
		for (let index = 0; index < 12; index++) children.push(await private_node(f, `/full/file-${index}.txt`, text));
		const proposals = [parent, ...children];
		const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		await f.t.run(async (ctx) => {
			for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
				const id = await quotas_db_ensure(ctx, { ...f.scope, quotaName, now: Date.now() });
				await ctx.db.patch("quotas", id, { maxCount: 0 });
			}
		});
		const result = await finish_review(f, await start_review(f, proposals));
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: proposals.length } });
		expect(result?.run.unitCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{
				status: "blocked",
				errorCode: "storage_full",
				errorMessage: "Save preparation space is full. Try again after cleanup finishes",
			},
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
		expect(await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(beforeBilling);
		expect(enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")).toEqual([]);
		const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		const publicationHolds = holds.filter((hold) => hold.publicationBatchId && hold.settlement.kind === "held");
		const publicationBytes = publicationHolds.reduce((sum, hold) => sum + hold.byteCount, 0);
		expect(publicationBytes).toBeGreaterThan(20 * 1024 * 1024 - 2 * 1024 * 1024);
		expect(publicationBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
		expect(publicationHolds.length).toBeLessThan(128);
		expect(holds.some((hold) => hold.settlement.kind === "saved")).toBe(false);
		const quotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
		for (const quota of quotas.filter(
			(quota) => quota.quotaName === "files_private_user_bytes" || quota.quotaName === "files_private_workspace_bytes",
		)) {
			const heldBytes = holds
				.filter(
					(hold) =>
						hold.settlement.kind === "held" &&
						hold.resource.kind !== "node" &&
						(hold.userQuotaId === quota._id || hold.workspaceQuotaId === quota._id),
				)
				.reduce((sum, hold) => sum + hold.byteCount, 0);
			expect(quota.usedCount).toBe(heldBytes);
		}
	}, 120_000);

	test.each([false, true])(
		"rolls back a connected content unit above the commit budget (anonymous: %s)",
		async (anonymous) => {
			const f = await fixture(anonymous);
			const parent = await private_node(f, "/large");
			const children = [];
			for (let index = 0; index < 64; index++)
				children.push(await private_node(f, `/large/file-${index}.txt`, `file ${index}\n`));
			const proposals = [parent, ...children];
			const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			// Let preparation refill the real Save rate limit without running background jobs.
			uploadDurationMs = 1_200;
			const runId = await start_review(f, proposals);
			const startedAt = Date.now();
			const result = await finish_review(f, runId);
			expect(Date.now() - startedAt).toBeGreaterThan(0);
			expect(Date.now() - startedAt).toBeLessThan(5 * 60 * 1000);
			expect(result?.activity).toMatchObject({
				status: "failed",
				progress: { completed: 0, blocked: proposals.length },
			});
			expect(result?.run.unitCount).toBe(1);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
				{ status: "blocked", errorCode: "review_too_large" },
			]);
			expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
			expect(await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(beforeBilling);
			const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			expect(holds.some((hold) => hold.publicationBatchId)).toBe(true);
			expect(holds.some((hold) => hold.settlement.kind === "saved")).toBe(false);
			if (!anonymous) {
				const calls = enqueue.mock.calls.flatMap((call, index) =>
					getFunctionName(call[1]) === "billing:ingest_events" ? [index] : [],
				);
				// At least one write was attempted before the transaction reached its limit.
				expect(calls.length).toBeGreaterThan(0);
				const enqueued = await Promise.allSettled(calls.map((index) => enqueue.mock.results[index]!.value));
				expect(enqueued.some((result) => result.status === "fulfilled")).toBe(true);
				for (const result of enqueued) {
					// The limit can refuse the last enqueue before it returns a work ID.
					if (result.status === "rejected") {
						expect(result.reason).toMatchObject({ data: { data: { code: "review_too_large" } } });
						continue;
					}
					const workId = result.value;
					expect(
						await f.t.query((ctx) => new Workpool(components.billing_workpool_usage_event, {}).status(ctx, workId)),
					).toEqual({ state: "finished" });
				}
			}
		},
		120_000,
	);
});
