// Fixtures shared by the files_pending_media_save test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_convex,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";

export const objects = new Map<string, BodyInit>();

// Each test file calls this in `beforeEach`.
export function mock_media_storage() {
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
}

export async function fixture() {
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

export async function proposal(f: Awaited<ReturnType<typeof fixture>>, target: Doc<"files_pending_updates">["target"]) {
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

export async function private_text(
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

export async function saved_proposal(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	target: Doc<"files_pending_updates">["target"];
	staged: string;
	unstaged?: string;
}) {
	const { f, target, staged, unstaged = staged } = args;

	const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: f.membershipId,
		target,
		expectedPendingContentVersion: await f.asUser.run(async (ctx) =>
			target.kind === "saved" ? (await ctx.db.get("files_nodes", target.id))!.pendingContentVersion : null,
		),
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

export async function media(f: Awaited<ReturnType<typeof fixture>>, path = "/photo.png") {
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
	return { pending: await proposal(f, target), src: files_media_build_private_src(target.id) };
}

export async function save(f: Awaited<ReturnType<typeof fixture>>, pending: Doc<"files_pending_updates">) {
	return await test_save_file_pending_update(f.asUser, {
		membershipId: f.membershipId,
		target: pending.target,
		pendingUpdateId: pending._id,
		reviewedRevision: pending.revision,
	});
}

export async function saved_doc(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">) {
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

export async function bulk_save(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	selected: Doc<"files_pending_updates">[];
	afterPlan?: () => Promise<void>;
}) {
	const { f, selected, afterPlan } = args;

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
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) =>
					q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
				)
				.first(),
		);
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
		if (run?.step !== "planning") break;
		if (pass === 99) throw new Error("Review planning did not finish");
	}
	await afterPlan?.();
	await test_finish_pending_update_run(f.asUser, runId);
	const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.membershipId, runId });
	const units = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_update_run_units")
			.withIndex("by_run_order", (q) => q.eq("runId", runId))
			.collect(),
	);
	return result
		? {
				...result,
				errors: units
					.map((unit) => unit.errorMessage)
					.filter(Boolean)
					.join("\n"),
			}
		: null;
}

export async function copy_replacement(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	source: Doc<"files_pending_updates">["target"];
	targetName: string;
}) {
	const { f, source, targetName } = args;

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
		const view = await f.asUser.query(api.files_transfer_status.get, { membershipId: f.membershipId, runId });
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

export async function cross_workspace_copy(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	source: Doc<"files_pending_updates">["target"];
	mediaSources?: Doc<"files_pending_updates">["target"][];
}) {
	const { f, source, mediaSources = [] } = args;

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
		const view = await f.asUser.query(api.files_transfer_status.get, { membershipId: f.membershipId, runId });
		if (view?.activity.status === "succeeded" && item?.outputTarget)
			return {
				destination,
				pending: await proposal(destination, item.outputTarget),
				media: items.slice(1).map((media) => media.outputTarget!),
			};
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
