// Fixtures shared by the files_transfer_scopes_content test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { expect, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	test_save_file_pending_update,
	test_convex,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import { files_media_build_file_src } from "../shared/files-media.ts";
import { files_u8_to_array_buffer, files_YJS_DOC_KEYS, type files_PendingTarget } from "../shared/files.ts";

export const objects = new Map<string, BodyInit>();

// Each test file calls this in `beforeEach`.
export function mock_scope_copy_storage() {
	vi.useFakeTimers();
	objects.clear();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `scope-copy-${++workCount}` as never);
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
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "team", workspaceName: "home" }),
	);
	const personal = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: personal.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: personal.userId,
		}),
	).toEqual({ _yay: null });
	expect(
		await asOwner.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: owner.organizationId,
			billingMode: "organization_owner",
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", personal.userId).eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Missing team membership");
	const current = {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userId: personal.userId,
		membershipId: membership._id,
	};
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: current.membershipId,
		clientGeneratedId: "scope-copy-chat",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	return { t, owner, current, personal, asOwner, asUser, threadId: created._yay.threadId };
}

export async function start_copy(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	source: files_PendingTarget;
	sourceWorkspace?: "current" | "personal";
	destinationWorkspace?: "current" | "personal";
}) {
	const { f, source, sourceWorkspace = "personal", destinationWorkspace = "current" } = args;

	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.current.membershipId,
		threadId: f.threadId,
		sourceWorkspace,
		destinationWorkspace,
		requestId: "scope-copy",
		kind: "copy",
		expectedSourceCount: 1,
		sources: [source],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: "copy.txt",
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 16; step++) {
		await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const item = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.first(),
		);
		if (item?.workId)
			return { ...started._yay, item, claim: { itemId: item._id, attempt: item.attempt, workId: item.workId } };
		if (item?.state === "failed") throw new Error(item.errorMessage!);
	}
	throw new Error("Copy did not start");
}

export async function append_saved_text(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	membershipId: Id<"organizations_workspaces_users">;
	nodeId: Id<"files_nodes">;
	text: string;
}) {
	const { f, nodeId, text, membershipId } = args;

	const pointers = await test_get_file_yjs_pointers(f.t, nodeId);
	const asset = await f.t.run(async (ctx) => {
		const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
		return await ctx.db.get("files_r2_assets", snapshot!.assetId);
	});
	const document = new YjsDoc();
	try {
		applyUpdate(document, new Uint8Array(await new Response(objects.get(asset!.r2Key!)).arrayBuffer()));
		const before = encodeStateVector(document);
		const value = document.getText(files_YJS_DOC_KEYS.plainText);
		value.insert(value.length, text);
		expect(
			await f.asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId,
				nodeId,
				expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(document, before)),
				sessionId: "scope-copy-edit",
			}),
		).toMatchObject({ _yay: expect.anything() });
	} finally {
		document.destroy();
	}
}

export async function media_proposal(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	workspace: "current" | "personal";
	path?: string;
}) {
	const { f, workspace, path = "/photo.png" } = args;

	const scope = f[workspace];
	const prepared = await f.t.mutation(internal.files_ingestion.prepare_file, {
		...scope,
		requestId: `media:${workspace}:${path}`,
		attemptId: "media",
		path,
		size: 4,
		contentType: "image/png",
		digest: "a".repeat(64),
		content: { kind: "stored" },
	});
	if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored media");
	objects.set(prepared._yay.r2Key, new Uint8Array([1, 2, 3, 4]));
	const finalized = await f.t.mutation(internal.files_ingestion.finalize_file, {
		...scope,
		receiptId: prepared._yay.receiptId,
		attemptId: "media",
	});
	if (finalized._nay) throw new Error(finalized._nay.message);
	return finalized._yay.target;
}

export async function get_proposal(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	workspace: "current" | "personal";
	target: files_PendingTarget;
}) {
	const { f, workspace, target } = args;

	const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
		membershipId: f[workspace].membershipId,
		target,
	});
	if (!view?.entry.pendingUpdate) throw new Error("Expected a proposal");
	return view.entry.pendingUpdate;
}

export async function save_proposal(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	workspace: "current" | "personal";
	target: files_PendingTarget;
}) {
	const { f, workspace, target } = args;

	const proposal = await get_proposal({ f, workspace, target });
	return await test_save_file_pending_update(f.asUser, {
		membershipId: f[workspace].membershipId,
		target,
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
	});
}

export async function copy_files(
	f: Awaited<ReturnType<typeof fixture>>,
	args: {
		sources: files_PendingTarget[];
		sourceWorkspace: "current" | "personal";
		destinationWorkspace: "current" | "personal";
		targetName?: string;
	},
) {
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.current.membershipId,
		threadId: f.threadId,
		...args,
		requestId: crypto.randomUUID(),
		kind: "copy",
		expectedSourceCount: args.sources.length,
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: args.targetName ?? null,
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 64; step++) {
		await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.collect(),
		);
		if (items.length && items.every((item) => ["completed", "failed", "skipped", "canceled"].includes(item.state)))
			return items;
		for (const item of items) {
			if (item.state !== "copying" || !item.workId) continue;
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

export async function media_copy_source(f: Awaited<ReturnType<typeof fixture>>) {
	const media = await media_proposal({ f, workspace: "current" });
	const saved = await save_proposal({ f, workspace: "current", target: media });
	if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
	const documentId = await test_create_saved_text_file(f.t, {
		membershipId: f.current.membershipId,
		path: "/document.md",
		textContent: `Before\n\n![Photo](${files_media_build_file_src(saved._yay.target.id)})\n\nAfter\n`,
	});
	return [{ kind: "saved" as const, id: documentId }, saved._yay.target];
}
