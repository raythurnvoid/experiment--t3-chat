import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_transfer_db_get_entry_version } from "./files_transfer.ts";
import {
	files_pending_updates_action_prepare_content,
	files_pending_updates_db_commit_prepared_content,
} from "./files_pending_updates.ts";
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
import { r2_server_side_copy } from "./r2_client.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import {
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_compute_diff_update_from_yjs_doc,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";

const objects = new Map<string, BodyInit>();

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `media-save-${++workCount}` as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
		const body = objects.get(args.sourceKey)!;
		objects.set(args.destinationKey, body);
		return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (url.pathname === "/upload" && init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const membership = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "media-save-owner" });
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const scope = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
	};
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: membership.userId });
	return { t, membershipId: membership.membershipId, scope, asUser };
}

async function proposal(f: Awaited<ReturnType<typeof fixture>>, target: Doc<"files_pending_updates">["target"]) {
	const pending = await f.t.run((ctx) =>
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
			.first(),
	);
	if (!pending) throw new Error("Expected the proposal");
	return pending;
}

async function private_text(
	f: Awaited<ReturnType<typeof fixture>>,
	args: {
		staged: string;
		unstaged?: string;
		collaborative?: boolean;
		path?: string;
	},
) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		path: args.path ?? "/document.md",
		kind: "file",
	});
	if (created._nay) throw new Error(created._nay.message);
	const { target, pendingUpdateId, operationBatchId } = created._yay;
	if (!pendingUpdateId || !operationBatchId) throw new Error("Expected a new text draft");
	if (args.collaborative === false) {
		// Match the non-collaborative fixture used by the main Save tests.
		await f.t.run(async (ctx) => {
			const pending = await ctx.db.get("files_pending_updates", pendingUpdateId);
			if (pending?.createIntent?.kind !== "text") throw new Error("Expected a text draft");
			await ctx.db.patch("files_pending_updates", pendingUpdateId, {
				createIntent: { ...pending.createIntent, collaborationEnabled: false },
			});
		});
	}
	for (const [role, text] of [
		["staged", args.staged],
		["unstaged", args.unstaged ?? args.staged],
	] as const) {
		const staged = await f.asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: f.membershipId,
			operationBatchId,
			role,
			text,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const ready = await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...f.scope,
		target,
		pendingUpdateId,
		operationBatchId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	return await proposal(f, target);
}

async function saved_proposal(
	f: Awaited<ReturnType<typeof fixture>>,
	target: Doc<"files_pending_updates">["target"],
	staged: string,
	unstaged = staged,
) {
	const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: f.membershipId,
		target,
	});
	if (batch._nay) throw new Error(batch._nay.message);
	for (const [role, text] of [
		["staged", staged],
		["unstaged", unstaged],
	] as const) {
		const result = await f.asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: f.membershipId,
			operationBatchId: batch._yay.operationBatchId,
			role,
			text,
		});
		if (result._nay) throw new Error(result._nay.message);
	}
	const ready = await f.asUser.action(api.ai_chat.upsert_file_pending_update, {
		membershipId: f.membershipId,
		target,
		operationBatchId: batch._yay.operationBatchId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	return await proposal(f, target);
}

async function media(f: Awaited<ReturnType<typeof fixture>>, path = "/photo.png") {
	const prepared = await f.t.mutation(internal.files_ingestion.prepare_file, {
		...f.scope,
		membershipId: f.membershipId,
		requestId: path,
		attemptId: "media",
		path,
		size: 4,
		contentType: path.endsWith(".mp4") ? "video/mp4" : "image/png",
		digest: "a".repeat(64),
		content: { kind: "stored" },
	});
	if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored media");
	objects.set(prepared._yay.r2Key, new Uint8Array([1, 2, 3, 4]));
	const completed = await f.t.mutation(internal.files_ingestion.finalize_file, {
		...f.scope,
		membershipId: f.membershipId,
		receiptId: prepared._yay.receiptId,
		attemptId: "media",
	});
	if (completed._nay || completed._yay.target.kind !== "private") throw new Error("Expected private media");
	const target = completed._yay.target;
	const version = await f.t.run(async (ctx) => {
		const reader = await files_visible_db_create_reader(ctx, f.scope);
		const entry = await reader.resolveTarget(target);
		if (!entry) throw new Error("Expected readable media");
		return await files_transfer_db_get_entry_version(ctx, entry);
	});
	if (!version) throw new Error("Expected a media version");
	return {
		pending: await proposal(f, target),
		dependency: {
			src: files_media_build_private_src(target.id),
			target,
			assetId: prepared._yay.assetId,
			version,
		},
	};
}

async function attach_dependencies(
	f: Awaited<ReturnType<typeof fixture>>,
	pending: Doc<"files_pending_updates">,
	dependencies: Doc<"files_media_dependencies">["dependency"][],
) {
	// Only dependency metadata is seeded: transfer mapping is covered by the copy tests.
	await f.t.run(async (ctx) => {
		const set = await files_media_dependencies_db_create(ctx, {
			...f.scope,
			owner: { kind: "proposal", pendingUpdateId: pending._id },
			expectedCount: dependencies.length,
		});
		if (set._nay) throw new Error(set._nay.message);
		for (let offset = 0; offset < dependencies.length; offset += 50) {
			const appended = await files_media_dependencies_db_append(ctx, {
				setId: set._yay,
				generation: 0,
				offset,
				mappings: dependencies
					.slice(offset, offset + 50)
					.map((dependency) => ({ sourceSrc: dependency.src, dependency })),
			});
			if (appended._nay) throw new Error(appended._nay.message);
		}
		expect(await files_media_dependencies_db_seal(ctx, { setId: set._yay, generation: 0 })).toEqual({ _yay: null });
		await ctx.db.patch("files_pending_updates", pending._id, { mediaDependencySetId: set._yay });
	});
	return await proposal(f, pending.target);
}

async function dependencies(f: Awaited<ReturnType<typeof fixture>>, pending: Doc<"files_pending_updates">) {
	if (!pending.mediaDependencySetId) throw new Error("Expected copied media dependencies");
	const setId = pending.mediaDependencySetId;
	return await f.t.run(async (ctx) =>
		(
			await ctx.db
				.query("files_media_dependencies")
				.withIndex("by_set_order", (q) => q.eq("setId", setId))
				.collect()
		).map((row) => row.dependency),
	);
}

async function save(f: Awaited<ReturnType<typeof fixture>>, pending: Doc<"files_pending_updates">) {
	return await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
		membershipId: f.membershipId,
		target: pending.target,
		pendingUpdateId: pending._id,
		reviewedRevision: pending.revision,
	});
}

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
		const preparedImage = await f.t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: f.scope.userId,
				membershipId: f.membershipId,
				target: nextImage.target,
				pendingUpdateId: nextImage._id,
				reviewedRevision: nextImage.revision,
				reviewedPrivateParentIds: [],
			}),
		);
		if (preparedImage._nay) throw new Error(preparedImage._nay.message);
		let validated: files_pending_media_ValidatedSave | undefined;
		await f.t.run(async (ctx) => {
			const proof = await files_pending_media_db_validate_prepared(ctx, {
				userId: f.scope.userId,
				prepared: prepared._yay,
				reviewedPendingUpdateIds: new Set(args.reviewedPendingUpdateIds),
			});
			if (proof._nay || !proof._yay) throw new Error("Expected a checked media proof");
			validated = proof._yay;
			const published = await files_pending_updates_db_commit_prepared_content(ctx, {
				userId: f.scope.userId,
				prepared: preparedImage._yay,
			});
			if (published._nay) throw new Error(published._nay.message);
			expect(published._yay.target.kind).toBe("saved");
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
});

async function document_proposal(
	f: Awaited<ReturnType<typeof fixture>>,
	kind: "private" | "yjs" | "asset",
	staged: string,
	unstaged = staged,
) {
	if (kind === "private") return await private_text(f, { staged, unstaged });
	const draft = await private_text(f, { staged: "Before\n\nMiddle\n\nAfter\n", collaborative: kind !== "asset" });
	const saved = await save(f, draft);
	if (saved._nay) throw new Error(saved._nay.message);
	return await saved_proposal(f, saved._yay.target, staged, unstaged);
}

async function saved_doc(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">) {
	const stored = await f.t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", nodeId);
		if (!node?.yjsSnapshotId) throw new Error("Expected saved Yjs");
		const snapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
		if (!snapshot) throw new Error("Expected snapshot");
		const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		return { node, snapshot, asset, updates };
	});
	const body = objects.get(stored.asset!.r2Key!);
	if (body === undefined) throw new Error("Expected snapshot bytes");
	return files_yjs_doc_create_from_array_buffer_update(await new Response(body).arrayBuffer(), {
		additionalIncrementalArrayBufferUpdates: stored.updates
			.filter((update) => update.sequence > stored.snapshot.sequence)
			.map((update) => update.update),
	});
}

async function bulk_save(
	f: Awaited<ReturnType<typeof fixture>>,
	selected: Doc<"files_pending_updates">[],
	afterPlan?: () => Promise<void>,
) {
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: selected.length,
		items: selected.map((pending) => ({
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
			selectedContentStateId: pending.content?.unstagedStateId ?? null,
		})),
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.membershipId, runId })).toEqual({
		_yay: null,
	});
	for (let pass = 0; pass < 100; pass++) {
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (run?.step !== "planning") break;
		if (pass === 99) throw new Error("Review planning did not finish");
	}
	await afterPlan?.();
	for (let pass = 0; pass < 20; pass++) {
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected review run");
		if (run.step === "finished")
			return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.membershipId, runId });
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

async function copy_replacement(
	f: Awaited<ReturnType<typeof fixture>>,
	source: Doc<"files_pending_updates">["target"],
	targetName: string,
) {
	const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
		membershipId: f.membershipId,
		clientGeneratedId: crypto.randomUUID(),
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.membershipId,
		sourceWorkspace: "current",
		destinationWorkspace: "current",
		threadId: thread._yay.threadId,
		requestId: crypto.randomUUID(),
		kind: "copy",
		expectedSourceCount: 1,
		sources: [source],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName,
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.membershipId,
			threadId: thread._yay.threadId,
			runId,
		}),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 24; pass++) {
		await f.t.mutation(internal.files_transfer.advance, { runId });
		const item = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		const view = await f.asUser.query(api.files_transfer.get, { membershipId: f.membershipId, runId });
		if (view?.activity.status === "succeeded" && item?.outputTarget) return await proposal(f, item.outputTarget);
		if (view?.activity.status === "failed") throw new Error(view.activity.errorMessage ?? "Copy failed");
		if (item?.workId && item.state !== "completed") {
			await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			await f.t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: item.workId,
				context: { itemId: item._id, attempt: item.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
	}
	throw new Error("Copy did not finish");
}

async function cross_workspace_copy(
	f: Awaited<ReturnType<typeof fixture>>,
	source: Doc<"files_pending_updates">["target"],
	mediaSources: Doc<"files_pending_updates">["target"][] = [],
) {
	const personal = await f.t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			userId: f.scope.userId,
			organizationName: "personal",
			workspaceName: "home",
		}),
	);
	const destination = {
		...f,
		membershipId: personal.membershipId,
		scope: {
			organizationId: personal.organizationId,
			workspaceId: personal.workspaceId,
			userId: personal.userId,
		},
	};
	const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
		membershipId: f.membershipId,
		clientGeneratedId: crypto.randomUUID(),
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.membershipId,
		threadId: thread._yay.threadId,
		requestId: crypto.randomUUID(),
		sourceWorkspace: "current",
		destinationWorkspace: "personal",
		kind: "copy",
		expectedSourceCount: 1 + mediaSources.length,
		sources: [source, ...mediaSources],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: null,
		missingParentNames: [],
		conflictPolicy: { file: "error", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.membershipId,
			threadId: thread._yay.threadId,
			runId,
		}),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 24; pass++) {
		await f.t.mutation(internal.files_transfer.advance, { runId });
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		const item = items[0];
		const view = await f.asUser.query(api.files_transfer.get, { membershipId: f.membershipId, runId });
		if (view?.activity.status === "succeeded" && item?.outputTarget)
			return { destination, pending: await proposal(destination, item.outputTarget) };
		if (view?.activity.status === "failed") throw new Error(view.activity.errorMessage ?? "Copy failed");
		for (const item of items) {
			if (item.workId && item.state === "copying") {
				await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
				await f.t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
			}
		}
	}
	throw new Error("Copy did not finish");
}

describe("Save copied rich-text media", () => {
	test.each(["private", "yjs", "asset"] as const)(
		"%s refuses unsaved media without changing the proposal or saved file",
		async (kind) => {
			const f = await fixture();
			const image = await media(f);
			const text = `Before\n\n![Photo](${image.dependency.src})\n\nAfter\n`;
			const pending = await attach_dependencies(f, await document_proposal(f, kind, text), [image.dependency]);
			const target = pending.target;
			const before = target.kind === "saved" ? await f.t.run((ctx) => ctx.db.get("files_nodes", target.id)) : null;
			const beforeDoc = kind === "yjs" && target.kind === "saved" ? await saved_doc(f, target.id) : null;
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			const billingCalls = () =>
				enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events").length;
			const billedBefore = billingCalls();
			expect(await save(f, pending)).toMatchObject({
				_nay: { message: expect.stringContaining("Save the selected media") },
			});
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
			expect((await save(f, pending))._nay).toBeUndefined();
			expect(billingCalls()).toBeGreaterThan(billedBefore);
		},
	);

	test.each(["private", "yjs", "asset"] as const)(
		"%s bulk Save accepts the document before its selected media",
		async (kind) => {
			const f = await fixture();
			const image = await media(f);
			const pending = await attach_dependencies(
				f,
				await document_proposal(f, kind, `![Photo](${image.dependency.src})\n`),
				[image.dependency],
			);
			const result = await bulk_save(f, [pending, image.pending]);
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
		const pending = await attach_dependencies(f, await private_text(f, { staged: text }), [
			selected.dependency,
			unselected.dependency,
		]);
		const result = await bulk_save(f, [selected.pending, pending]);
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
			const pending = await attach_dependencies(f, await document_proposal(f, kind, accepted, remaining), [
				image.dependency,
			]);
			const first = await save(f, pending);
			if (first._nay) throw new Error(first._nay.message);
			const partial = await proposal(f, first._yay.target);
			expect(await dependencies(f, partial)).toEqual([image.dependency]);
			const second = await saved_proposal(f, partial.target, remaining);
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
			const pending = await attach_dependencies(
				f,
				await document_proposal(f, kind, base, `${base}\n![Photo](${image.dependency.src})\n`),
				[image.dependency],
			);
			const saved = await save(f, pending);
			if (saved._nay) throw new Error(saved._nay.message);
			expect(await dependencies(f, await proposal(f, saved._yay.target))).toEqual([image.dependency]);
			expect(await proposal(f, image.pending.target)).toEqual(image.pending);
		},
	);

	test("Yjs checks accepted text merged with a live embed absent from the staged branch", async () => {
		const f = await fixture();
		const image = await media(f);
		const pending = await attach_dependencies(f, await document_proposal(f, "yjs", "BEFORE\n\nMiddle\n\nAfter\n"), [
			image.dependency,
		]);
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
		const pending = await attach_dependencies(f, await private_text(f, { staged: text }), [image.dependency]);
		expect((await save(f, pending))._nay).toBeUndefined();
		expect(await proposal(f, image.pending.target)).toEqual(image.pending);
	});

	test("a saved private alias joins its new media delete and refuses the whole review unit", async () => {
		const f = await fixture();
		const image = await media(f);
		const saved = await save(f, image.pending);
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const target = saved._yay.target;
		const pending = await attach_dependencies(
			f,
			await private_text(f, { staged: `![Photo](${image.dependency.src})\n` }),
			[image.dependency],
		);
		expect(
			(await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...f.scope, target }))
				._nay,
		).toBeUndefined();
		const archive = await proposal(f, target);
		expect(archive._id).not.toBe(image.pending._id);
		expect(await save(f, pending)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		expect((await bulk_save(f, [pending, archive]))?.activity).toMatchObject({
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
			const replacement = await copy_replacement(f, source.pending.target, "photo.png");
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
			const pending = await attach_dependencies(f, await private_text(f, { staged: `![Photo](${dependency.src})\n` }), [
				dependency,
			]);
			const result = await bulk_save(f, [pending, replacement]);
			if (expectsReplacement) {
				expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
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
		const replacement = await attach_dependencies(f, await copy_replacement(f, source.target, "document.md"), [
			image.dependency,
		]);
		expect(await save(f, replacement)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		const result = await bulk_save(f, [replacement, image.pending]);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
	});
});

describe("cross-workspace Copy from public Save", () => {
	test("a later document refusal rolls back the earlier copied media Save", async () => {
		const f = await fixture();
		const source = await media(f);
		const savedSource = await save(f, source.pending);
		if (savedSource._nay) throw new Error(savedSource._nay.message);
		const copied = await cross_workspace_copy(f, savedSource._yay.target);
		const target = copied.pending.target;
		if (target.kind !== "private" || copied.pending.createIntent?.kind !== "stored")
			throw new Error("Expected private media");
		const version = await f.t.run(async (ctx) => {
			const entry = await (await files_visible_db_create_reader(ctx, copied.destination.scope)).resolveTarget(target);
			if (!entry) throw new Error("Expected copied media");
			return await files_transfer_db_get_entry_version(ctx, entry);
		});
		if (!version) throw new Error("Expected copied media version");
		const selected = {
			src: files_media_build_private_src(target.id),
			target,
			assetId: copied.pending.createIntent.assetId,
			version,
		};
		const unselected = await media(copied.destination, "/clip.mp4");
		const doc = await attach_dependencies(
			copied.destination,
			await private_text(copied.destination, {
				staged: `![Photo](${selected.src})\n\n<video src="${unselected.dependency.src}" controls></video>\n`,
			}),
			[selected, unselected.dependency],
		);
		const result = await bulk_save(copied.destination, [copied.pending, doc]);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 2 } });
		expect(await proposal(copied.destination, target)).toEqual(copied.pending);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({ state: "active" });
	});

	test.each(["document.md", "document.txt", "asset.md", "photo.png", "folder"])(
		"full %s Copy Save publishes the file and removes its proposal",
		async (name) => {
			const f = await fixture();
			let source: Doc<"files_pending_updates">;
			if (name === "folder") {
				const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
					...f.scope,
					path: "/folder",
					kind: "folder",
				});
				if (created._nay) throw new Error(created._nay.message);
				source = await proposal(f, created._yay.target);
			} else if (name === "photo.png") source = (await media(f)).pending;
			else
				source = await private_text(f, {
					path: `/${name}`,
					staged: "First\n\nSecond\n",
					collaborative: name !== "asset.md",
				});
			const savedSource = await save(f, source);
			if (savedSource._nay || savedSource._yay.target.kind !== "saved") throw new Error("Expected saved source");
			const sourceId = savedSource._yay.target.id;
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			const copied = await cross_workspace_copy(f, savedSource._yay.target);
			const saved = await save(copied.destination, copied.pending);
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved copy");
			const savedId = saved._yay.target.id;
			expect(savedId).not.toBe(sourceId);
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedId))).toMatchObject({
				workspaceId: copied.destination.scope.workspaceId,
				path: `/${name}`,
				kind: name === "folder" ? "folder" : "file",
				archiveOperationId: null,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", copied.pending._id))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toEqual(before);
		},
	);

	test.each([
		{ name: "rich Yjs", path: "/document.md", collaborative: true },
		{ name: "plain Yjs", path: "/document.txt", collaborative: true },
		{ name: "asset text", path: "/document.md", collaborative: false },
	])("$name partial Save waits for a later full Save of the same proposal", async ({ path, collaborative }) => {
		const f = await fixture();
		const text = "First\n\nSecond\n";
		const source = await private_text(f, { path, staged: text, collaborative });
		const savedSource = await save(f, source);
		if (savedSource._nay) throw new Error(savedSource._nay.message);
		const copied = await cross_workspace_copy(f, savedSource._yay.target);
		const partial = await saved_proposal(copied.destination, copied.pending.target, "First\n", text);
		const savedPart = await save(copied.destination, partial);
		if (savedPart._nay) throw new Error(savedPart._nay.message);
		const full = await saved_proposal(copied.destination, savedPart._yay.target, text);
		expect(full._id).toBe(partial._id);
		const saved = await save(copied.destination, full);
		if (saved._nay) throw new Error(saved._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
		if (savedSource._yay.target.kind !== "saved") throw new Error("Expected saved source");
		const sourceId = savedSource._yay.target.id;
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.archiveOperationId).toBeNull();
	});

	test.each([true, false])(
		"bulk full Copy Save without a new publication keeps the saved file (collaboration: %s)",
		async (collaborative) => {
			const f = await fixture();
			const text = "First\n";
			const source = await private_text(f, { path: "/document.txt", staged: text, collaborative });
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy(f, savedSource._yay.target);
			const partial = await saved_proposal(copied.destination, copied.pending.target, text, `${text}Extra\n`);
			const savedPart = await save(copied.destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			const full = await saved_proposal(copied.destination, savedPart._yay.target, `${text}Unselected\n`, text);
			expect(full._id).toBe(partial._id);
			const saved = await bulk_save(copied.destination, [full]);
			expect(saved?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1, blocked: 0 } });
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
		},
	);

	test.each([
		{ collaborative: false, replaceMedia: true },
		{ collaborative: true, replaceMedia: true },
		{ collaborative: false, replaceMedia: false },
		{ collaborative: true, replaceMedia: false },
	])(
		"no-publication full Save checks rich media (collaboration: $collaborative, replacement: $replaceMedia)",
		async ({ collaborative, replaceMedia }) => {
			const f = await fixture();
			const sourceImage = await media(f);
			const savedSourceImage = await save(f, sourceImage.pending);
			if (savedSourceImage._nay) throw new Error(savedSourceImage._nay.message);
			const source = await private_text(f, {
				staged: `First\n\n![Photo](${sourceImage.dependency.src})\n`,
				collaborative,
			});
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy(f, savedSource._yay.target, [savedSourceImage._yay.target]);
			const destination = copied.destination;
			const mappings = await dependencies(destination, copied.pending);
			expect(mappings).toHaveLength(1);
			const dependency = mappings[0]!;
			const savedImage = await save(destination, await proposal(destination, dependency.target));
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `First\n\n![Photo](${dependency.src})\n`;
			const partial = await saved_proposal(destination, copied.pending.target, text, `${text}\nExtra\n`);
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;

			// Bulk Save selects U, which is already committed; S still has an unselected edit.
			const full = await saved_proposal(destination, savedPart._yay.target, `${text}\nUnselected\n`, text);
			expect(full._id).toBe(partial._id);
			expect(await dependencies(destination, full)).toEqual([dependency]);
			let replacement: Doc<"files_pending_updates"> | null = null;
			if (replaceMedia) {
				const newImage = await media(destination, "/new.png");
				replacement = await copy_replacement(destination, newImage.pending.target, "photo.png");
				expect(replacement.pendingReplacement!.assetId).not.toBe(dependency.assetId);
			}
			const before = await f.t.run(async (ctx) => ({
				document: await ctx.db.get("files_nodes", nodeId),
				image: await ctx.db.get("files_nodes", imageNodeId),
				assets: await ctx.db.query("files_r2_assets").collect(),
			}));
			const objectsBefore = new Map(objects);
			const result = await bulk_save(destination, replacement ? [full, replacement] : [full]);
			const reviewed = await f.t.run(async (ctx) => {
				const items = await ctx.db.query("files_pending_update_run_items").collect();
				const item = items.find((item) => item.pendingUpdateId === full._id)!;
				return { prepared: item.prepared, unit: await ctx.db.get("files_pending_update_run_units", item.unitId!) };
			});
			expect(reviewed.prepared?.kind).toBe(collaborative ? "saved_yjs" : "saved_asset");
			if (reviewed.prepared?.kind === "saved_asset") {
				expect(reviewed.prepared.publish).toBeNull();
				expect(reviewed.prepared.partial).toBeUndefined();
				expect(reviewed.prepared.unchanged).toBeUndefined();
			} else if (reviewed.prepared?.kind === "saved_yjs") {
				expect(reviewed.prepared.trustedStageId).toBeUndefined();
				expect(reviewed.prepared.partial).toBeUndefined();
			}

			if (replacement) {
				const replacementId = replacement._id;
				expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 2 } });
				expect(reviewed.unit).toMatchObject({
					status: "blocked",
					itemCount: 2,
					errorMessage: expect.stringContaining("Save the selected media"),
				});
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toEqual(full);
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", replacementId))).toEqual(replacement);
			} else {
				expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1, blocked: 0 } });
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
			}
			expect(
				await f.t.run(async (ctx) => ({
					document: await ctx.db.get("files_nodes", nodeId),
					image: await ctx.db.get("files_nodes", imageNodeId),
					assets: await ctx.db.query("files_r2_assets").collect(),
				})),
			).toEqual(before);
			expect(objects).toEqual(objectsBefore);
		},
	);

	test.each([
		{ collaborative: false, removeEmbed: true },
		{ collaborative: true, removeEmbed: true },
		{ collaborative: false, removeEmbed: false },
		{ collaborative: true, removeEmbed: false },
	])(
		"bulk Save groups only selected embeds (collaboration: $collaborative, removed: $removeEmbed)",
		async ({ collaborative, removeEmbed }) => {
			const f = await fixture();
			const sourceImage = await media(f);
			const savedSourceImage = await save(f, sourceImage.pending);
			if (savedSourceImage._nay) throw new Error(savedSourceImage._nay.message);
			const source = await private_text(f, {
				staged: `First\n\n![Photo](${sourceImage.dependency.src})\n`,
				collaborative,
			});
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy(f, savedSource._yay.target, [savedSourceImage._yay.target]);
			const destination = copied.destination;
			const mappings = await dependencies(destination, copied.pending);
			expect(mappings).toHaveLength(1);
			const dependency = mappings[0]!;
			const savedImage = await save(destination, await proposal(destination, dependency.target));
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `First\n\n![Photo](${dependency.src})\n`;
			const partial = await saved_proposal(destination, copied.pending.target, text, `${text}\nExtra\n`);
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;
			expect(await dependencies(destination, await proposal(destination, savedPart._yay.target))).toEqual([dependency]);

			// S keeps the image, but bulk Save selects U. Only U may remove this grouping edge.
			const accepted = removeEmbed ? "Changed without an image\n" : `${text}\nChanged\n`;
			const full = await saved_proposal(destination, savedPart._yay.target, text, accepted);
			expect(await dependencies(destination, full)).toEqual([dependency]);
			const newImage = await media(destination, "/new.png");
			const replacement = await copy_replacement(destination, newImage.pending.target, "photo.png");
			expect(replacement.pendingReplacement!.assetId).not.toBe(dependency.assetId);
			const imageAssets = await f.t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", dependency.assetId),
					ctx.db.get("files_r2_assets", replacement.pendingReplacement!.assetId),
				]),
			);
			const imageObjects = imageAssets.map((asset) => objects.get(asset!.r2Key!));
			let imageBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId));
			const result = await bulk_save(destination, [full, replacement], async () => {
				// Lock after selection and planning, so the worker must recheck the plan and write policy.
				expect(
					await destination.asUser.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: destination.membershipId,
						nodeId: imageNodeId,
						writePolicy: { mode: "read_only" },
					}),
				).toEqual({ _yay: null });
				imageBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId));
			});
			expect(result?.activity).toMatchObject({
				status: removeEmbed ? "partial" : "failed",
				progress: { completed: removeEmbed ? 1 : 0, blocked: removeEmbed ? 1 : 2 },
			});
			expect(result?.run.unitCount).toBe(removeEmbed ? 2 : 1);
			const items = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect());
			const documentItem = items.find((item) => item.pendingUpdateId === full._id)!;
			const imageItem = items.find((item) => item.pendingUpdateId === replacement._id)!;
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", imageItem.unitId!))).toMatchObject({
				status: "blocked",
				errorCode: "read_only",
			});
			if (removeEmbed) {
				expect(documentItem.unitId).not.toBe(imageItem.unitId);
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
				if (collaborative) {
					const doc = await saved_doc(destination, nodeId);
					expect(files_yjs_doc_get_text({ yjsDoc: doc, rootKind: "rich_text" })._yay).toBe(accepted);
					doc.destroy();
				} else {
					const asset = await f.t.run(async (ctx) => {
						const node = await ctx.db.get("files_nodes", nodeId);
						return await ctx.db.get("files_r2_assets", node!.assetId!);
					});
					expect(await new Response(objects.get(asset!.r2Key!)).text()).toBe(accepted);
				}
			} else {
				expect(documentItem.unitId).toBe(imageItem.unitId);
				expect(await proposal(destination, full.target)).toEqual(full);
			}
			expect(await proposal(destination, replacement.target)).toEqual(replacement);
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId))).toEqual(imageBefore);
			expect(
				await f.t.run((ctx) => Promise.all(imageAssets.map((asset) => ctx.db.get("files_r2_assets", asset!._id)))),
			).toEqual(imageAssets);
			expect(imageAssets.map((asset) => objects.get(asset!.r2Key!))).toEqual(imageObjects);
		},
	);

	test.each([true, false])(
		"bulk Save checks a live embed added after planning (replacement selected: %s)",
		async (selectReplacement) => {
			const f = await fixture();
			const sourceImage = await media(f);
			const savedSourceImage = await save(f, sourceImage.pending);
			if (savedSourceImage._nay) throw new Error(savedSourceImage._nay.message);
			const source = await private_text(f, {
				staged: `Intro\n\n![Original](${sourceImage.dependency.src})\n\nFooter\n`,
				collaborative: true,
			});
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy(f, savedSource._yay.target, [savedSourceImage._yay.target]);
			const destination = copied.destination;
			const mappings = await dependencies(destination, copied.pending);
			expect(mappings).toHaveLength(1);
			const dependency = mappings[0]!;
			const savedImage = await save(destination, await proposal(destination, dependency.target));
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `Intro\n\n![Original](${dependency.src})\n\nFooter\n`;
			const partial = await saved_proposal(destination, copied.pending.target, text, `${text}\nExtra\n`);
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;
			// S keeps the old embed. The selected U removes it but keeps the footer.
			const accepted = "Changed\n\nFooter\n";
			const full = await saved_proposal(destination, savedPart._yay.target, text, accepted);
			expect(await dependencies(destination, full)).toEqual([dependency]);
			const newImage = await media(destination, "/new.png");
			const replacement = await copy_replacement(destination, newImage.pending.target, "photo.png");
			expect(replacement.pendingReplacement!.assetId).not.toBe(dependency.assetId);
			const liveAppend = `\n![Live](${dependency.src})\n`;
			const result = await bulk_save(destination, [full, ...(selectReplacement ? [replacement] : [])], async () => {
				// The new embed is outside U's changed lines and arrives only after the units are planned.
				const before = await saved_doc(destination, nodeId);
				expect(files_yjs_doc_get_text({ yjsDoc: before, rootKind: "rich_text" })._yay).toBe(text);
				const edited = files_yjs_doc_clone({ yjsDoc: before });
				expect(
					files_yjs_doc_update_from_text({ mut_yjsDoc: edited, rootKind: "rich_text", text: text + liveAppend })._nay,
				).toBeUndefined();
				const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
				if (!update) throw new Error("Expected live append");
				const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
				expect(
					(
						await destination.asUser.mutation(api.files_nodes.yjs_push_update, {
							membershipId: destination.membershipId,
							nodeId,
							expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
							update: files_u8_to_array_buffer(update),
							sessionId: "live-media-after-plan",
						})
					)._nay,
				).toBeUndefined();
				before.destroy();
				edited.destroy();
				expect(await proposal(destination, full.target)).toEqual(full);
			});
			const pending = await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id));
			const after = await saved_doc(destination, nodeId);
			const finalText = files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })._yay;
			after.destroy();
			if (selectReplacement) {
				// The image may save independently, but the document must not publish this changed link.
				expect(result?.activity.progress?.completed).toBeLessThan(2);
				expect(pending).toEqual(full);
				expect(finalText).toBe(text + liveAppend);
			} else {
				// A replacement outside this Save must not block use of the unchanged saved media.
				expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1, blocked: 0 } });
				expect(pending).toBeNull();
				expect(finalText).toBe(accepted + liveAppend);
				expect(await proposal(destination, replacement.target)).toEqual(replacement);
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId))).toMatchObject({
					assetId: dependency.assetId,
				});
			}
		},
	);

	test.each(["rich_text", "plain_text"] as const)("%s Copy Save keeps the accepted live merge", async (rootKind) => {
		const f = await fixture();
		const text = "First\n\nSecond\n";
		const source = await private_text(f, {
			path: rootKind === "rich_text" ? "/document.md" : "/document.txt",
			staged: text,
		});
		const savedSource = await save(f, source);
		if (savedSource._nay) throw new Error(savedSource._nay.message);
		const copied = await cross_workspace_copy(f, savedSource._yay.target);
		const partial = await saved_proposal(copied.destination, copied.pending.target, "First\n", text);
		const savedPart = await save(copied.destination, partial);
		if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
		const nodeId = savedPart._yay.target.id;
		const full = await saved_proposal(copied.destination, savedPart._yay.target, text);
		const before = await saved_doc(copied.destination, nodeId);
		const edited = files_yjs_doc_clone({ yjsDoc: before });
		expect(files_yjs_doc_update_from_text({ mut_yjsDoc: edited, rootKind, text: "LIVE\n" })._nay).toBeUndefined();
		const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
		if (!update) throw new Error("Expected live edit");
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		expect(
			(
				await f.asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: copied.destination.membershipId,
					nodeId,
					expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
					update: files_u8_to_array_buffer(update),
					sessionId: "live-copy",
				})
			)._nay,
		).toBeUndefined();
		before.destroy();
		edited.destroy();
		const saved = await save(copied.destination, full);
		if (saved._nay) throw new Error(saved._nay.message);
		const after = await saved_doc(copied.destination, nodeId);
		const accepted = files_yjs_doc_get_text({ yjsDoc: after, rootKind });
		expect(accepted._yay).toContain("LIVE");
		expect(accepted._yay).toContain("Second");
		after.destroy();
	});
});
