/// <reference types="vite/client" />
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { streamText } from "ai";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import { files_browser_db_delete_user_batch } from "./files_browser.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";

const runnerQueue: Array<unknown> = [];
const runnerCalls: Array<{ route: string; body: Record<string, unknown> }> = [];
const r2Objects = new Map<string, Uint8Array>();
let r2FetchCount = 0;

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: model.streamText,
}));

async function stub_body_to_bytes(body: unknown) {
	if (body === null || body === undefined) {
		return new Uint8Array();
	}
	if (typeof body === "string") {
		return new TextEncoder().encode(body);
	}
	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body);
	}
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	return new Uint8Array();
}

beforeEach(() => {
	model.streamText.mockReset();
	model.streamText.mockImplementation(() => ({
		toUIMessageStream: () =>
			new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "start", messageId: "answer" });
					controller.enqueue({ type: "finish" });
					controller.close();
				},
			}),
		response: Promise.resolve({ messages: [] }),
		consumeStream: async () => {},
	}));
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_browser_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	runnerQueue.length = 0;
	runnerCalls.length = 0;
	r2Objects.clear();
	r2FetchCount = 0;
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("https://browser-runner.test/")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				runnerCalls.push({ route: url.slice(url.lastIndexOf("/") + 1), body });
				const next = runnerQueue.shift();
				if (next === undefined) throw new Error("runner mock queue is empty");
				return Response.json(next);
			}
			if (url.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = new URL(url).searchParams.get("key") ?? "";
				r2Objects.set(key, await stub_body_to_bytes(init.body));
				return new Response(null, { status: 200 });
			}
			if (url.startsWith("https://r2.test/object")) {
				r2FetchCount += 1;
				const key = new URL(url).searchParams.get("key") ?? "";
				const bytes = r2Objects.get(key);
				if (!bytes) return new Response("missing", { status: 404 });
				return new Response(bytes as BodyInit);
			}
			throw new Error(`unexpected real fetch: ${url.slice(0, 120)}`);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const HTML_TEXT = "<!doctype html>\n<html><head><title>T</title></head><body><p>Hi</p></body></html>\n";

type BrowserFixture = {
	membershipId: Id<"organizations_workspaces_users">;
	userId: Id<"users">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
	path: string;
};

async function seed_html_file(t: ReturnType<typeof test_convex>, path = "/page.html"): Promise<BrowserFixture> {
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path,
		textContent: HTML_TEXT,
	});
	return { ...db, nodeId, path };
}

async function seed_private_html_file(t: ReturnType<typeof test_convex>, path = "/draft.html") {
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const membership = await t.run((ctx) => ctx.db.get("organizations_workspaces_users", db.membershipId));
	if (!membership) throw new Error("Expected a test membership");
	const scope = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
	};
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path,
		kind: "file",
	});
	if (created._nay) throw new Error(created._nay.message);
	const { target, pendingUpdateId, operationBatchId } = created._yay;
	if (target.kind !== "private" || !pendingUpdateId || !operationBatchId) {
		throw new Error("Expected a private text proposal");
	}
	for (const role of ["staged", "unstaged"] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId,
			role,
			text: HTML_TEXT,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...scope,
		target,
		pendingUpdateId,
		operationBatchId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	return { ...db, nodeId: target.id, path };
}

function authed(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	return t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
}

function runner_open_session(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		session: {
			sessionId: "runner-session-1",
			nodeId: "node-1",
			navGen: 1,
			loadGen: 1,
			controlGen: 1,
			control: "ready" as const,
			sourceKind: "saved" as const,
			sourceVersion: "v1",
			sourceHash: "hash",
			idleUntil: Date.now() + 300_000,
			totalUntil: Date.now() + 1_200_000,
			...overrides,
		},
	};
}

async function start_saved_session(
	t: ReturnType<typeof test_convex>,
	fixture: BrowserFixture,
	overrides: Record<string, unknown> = {},
) {
	runnerQueue.push(runner_open_session({ nodeId: fixture.nodeId }));
	const asUser = authed(t, fixture.userId);
	return await asUser.action(api.files_browser.start_browser, {
		membershipId: fixture.membershipId,
		targetKind: "saved",
		nodeId: fixture.nodeId,
		path: fixture.path,
		sourceKind: "saved",
		navigationGeneration: 1,
		navigationClientId: "client-1",
		viewport: { width: 1280, height: 900 },
		...overrides,
	});
}

async function sha256_hex(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Open a browser session on an HTML file. File outputs need the session's current lease and
 * source values, so return those together with the scope and a chat thread.
 */
async function seed_browser_file_scope(t: ReturnType<typeof test_convex>) {
	const fixture = await seed_html_file(t);
	const started = await start_saved_session(t, fixture);
	if (started._nay) throw new Error(started._nay.message);

	const session = await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.sessionId));
	if (!session) throw new Error("Expected browser session");

	const threadId = await t.run((ctx) =>
		ctx.db.insert("ai_chat_threads", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			clientGeneratedId: "browser-files",
			title: null,
			archived: false,
			runtime: "aisdk_5",
			createdBy: fixture.userId,
			updatedBy: fixture.userId,
			updatedAt: Date.now(),
		}),
	);

	return {
		membershipId: fixture.membershipId,
		userId: fixture.userId,
		organizationId: fixture.organizationId,
		workspaceId: fixture.workspaceId,
		threadId,
		modeId: "agent" as const,
		sessionId: session._id,
		expectedAgentLease: {
			controlGen: session.controlGen,
			loadGen: session.loadGen,
			navGen: session.navigationGeneration,
		},
		expectedSource: {
			targetKind: session.targetKind,
			nodeId: session.nodeId,
			sourceKind: session.sourceKind,
			sourceVersion: session.sourceVersion,
			sourceHash: session.sourceHash,
		},
	};
}

const browserFile = {
	requestId: "file-output-1",
	attemptId: "attempt-1",
	path: "/reports/capture.bin",
	size: 8,
	contentType: "application/octet-stream",
	digest: "a".repeat(64),
	content: { kind: "stored" as const },
};

async function prepare_browser_file(
	t: ReturnType<typeof test_convex>,
	scope: Awaited<ReturnType<typeof seed_browser_file_scope>>,
	changes: Partial<typeof browserFile> = {},
) {
	const prepared = await t.mutation(internal.files_browser.prepare_file_output, {
		...scope,
		...browserFile,
		...changes,
	});
	if (prepared._nay) throw new Error(prepared._nay.message);
	if (prepared._yay.kind !== "stored") throw new Error("Expected stored file preparation");
	return prepared._yay;
}

describe("browser file outputs", () => {
	test("creates generic files with exact parent review and replays after Save", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const first = await prepare_browser_file(t, scope);
		expect(
			(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).filter((node) => node.state === "active"),
		).toEqual([]);
		const finalArgs = { ...scope, receiptId: first.receiptId, attemptId: browserFile.attemptId };
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, finalArgs);
		if (finalized._nay) throw new Error(finalized._nay.message);
		const second = await prepare_browser_file(t, scope, {
			requestId: "file-output-2",
			size: 0,
			contentType: "application/x-custom",
		});
		const secondResult = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: second.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect([finalized._yay.path, secondResult._yay?.path]).toEqual(["/reports/capture.bin", "/reports/capture-2.bin"]);
		expect(secondResult._yay).toMatchObject({ size: 0, contentType: "application/x-custom" });

		const asUser = authed(t, scope.userId);
		const target = finalized._yay.target;
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		expect(view).toMatchObject({ readiness: "ready", canAccept: false, canAcceptWithParents: true });
		expect(view!.requiredParents.map((parent) => parent.path)).toEqual(["/reports"]);
		expect(view!.entry.pendingUpdate?.createIntent).toMatchObject({ kind: "stored", size: 8 });
		expect(view!.entry.pendingUpdate?.threadIds).toEqual([scope.threadId]);
		const readArgs = {
			userId: scope.userId,
			membershipId: scope.membershipId,
			threadId: scope.threadId,
			path: finalized._yay.path,
			target,
		};
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay?.assetId).toBe(
			first.assetId,
		);
		for (const parent of view!.requiredParents) {
			expect(
				(
					await asUser.action(api.files_pending_updates.save_file_pending_update, {
						membershipId: scope.membershipId,
						target: parent.target,
						pendingUpdateId: parent.pendingUpdateId,
						reviewedRevision: parent.reviewedRevision,
					})
				)._nay,
			).toBeUndefined();
		}
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: scope.membershipId,
			target,
			pendingUpdateId: view!.entry.pendingUpdate!._id,
			reviewedRevision: view!.entry.pendingUpdate!.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		if (target.kind !== "private") throw new Error("Expected private target");
		await t.run(async (ctx) => {
			const receipt = await ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", target.id))
				.first();
			if (receipt) await ctx.db.delete("files_pending_node_publish_receipts", receipt._id);
			await ctx.db.delete("files_pending_nodes", target.id);
			await ctx.db.patch("files_browser_sessions", scope.sessionId, { control: "closed" });
		});
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay?.target).toEqual(
			saved._yay.target,
		);
		// Completed retries resolve the same file. They cannot create again after the browser closes.
		expect((await t.mutation(internal.files_browser.finalize_file_output, finalArgs))._yay?.target).toEqual(
			saved._yay.target,
		);
		await t.mutation(internal.files_ingestion.abort_file, {
			userId: scope.userId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			receiptId: first.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", first.assetId))).not.toBeNull();
	});

	test("keeps completed files when a later item exceeds the node quota", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...scope, quotaName: "files_private_nodes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 2 });
		});
		const first = await prepare_browser_file(t, scope);
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: first.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect(finalized._yay).toBeDefined();
		expect(
			(
				await t.mutation(internal.files_browser.prepare_file_output, {
					...scope,
					...browserFile,
					requestId: "file-output-2",
					path: "/reports/second.bin",
				})
			)._nay,
		).toBeDefined();
		const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state === "active")).toHaveLength(2);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", first.assetId))).not.toBeNull();
	});

	test.each(["control", "load", "navigation", "source", "thread", "ask"] as const)(
		"rechecks %s before finalizing bytes",
		async (change) => {
			const t = test_convex();
			const scope = await seed_browser_file_scope(t);
			const prepared = await prepare_browser_file(t, scope);
			if (change === "control")
				await t.run((ctx) =>
					ctx.db.patch("files_browser_sessions", scope.sessionId, {
						controlGen: scope.expectedAgentLease.controlGen + 1,
					}),
				);
			if (change === "load")
				await t.run((ctx) =>
					ctx.db.patch("files_browser_sessions", scope.sessionId, { loadGen: scope.expectedAgentLease.loadGen + 1 }),
				);
			if (change === "navigation")
				await t.run((ctx) =>
					ctx.db.patch("files_browser_sessions", scope.sessionId, {
						navigationGeneration: scope.expectedAgentLease.navGen + 1,
					}),
				);
			if (change === "source")
				await t.run((ctx) => ctx.db.patch("files_browser_sessions", scope.sessionId, { sourceHash: "changed" }));
			if (change === "thread")
				await t.run((ctx) => ctx.db.patch("ai_chat_threads", scope.threadId, { archived: true }));
			expect(
				(
					await t.mutation(internal.files_browser.finalize_file_output, {
						...scope,
						...(change === "ask" ? { modeId: "ask" as const } : {}),
						receiptId: prepared.receiptId,
						attemptId: browserFile.attemptId,
					})
				)._nay,
			).toBeDefined();
			expect(
				(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).filter((node) => node.state === "active"),
			).toEqual([]);
			await t.mutation(internal.files_ingestion.abort_file, {
				userId: scope.userId,
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				receiptId: prepared.receiptId,
				attemptId: browserFile.attemptId,
			});
			const job = await t.run((ctx) =>
				ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", prepared.r2Key))
					.first(),
			);
			expect(job?.putMayArriveUntil).toBeGreaterThan(Date.now());
			expect(job?.privateStorageReservationId).toBeDefined();
			expect(
				(await t.run((ctx) => ctx.db.get("files_private_storage_reservations", job!.privateStorageReservationId!)))
					?.settlement.kind,
			).toBe("held");
		},
	);

	test("Ask and a foreign thread fail before allocating bytes", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		expect(
			(await t.mutation(internal.files_browser.prepare_file_output, { ...scope, ...browserFile, modeId: "ask" }))._nay,
		).toBeDefined();
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", scope.threadId, { workspaceId: "other-workspace" }));
		expect(
			(await t.mutation(internal.files_browser.prepare_file_output, { ...scope, ...browserFile }))._nay,
		).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toEqual([]);
	});

	test.each(["relative.bin", "/a/../out", "/a//out", "/a/*.bin", "/a/out "])(
		"refuses invalid path %s before reserving bytes",
		async (path) => {
			const t = test_convex();
			const scope = await seed_browser_file_scope(t);
			const assets = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
			expect(
				(await t.mutation(internal.files_browser.prepare_file_output, { ...scope, ...browserFile, path }))._nay,
			).toBeDefined();
			expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assets);
		},
	);

	test("never overwrites a saved name hidden by a proposed delete", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: scope.membershipId,
			path: browserFile.path,
			textContent: "existing file",
		});
		await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.userId,
				target: { kind: "saved", id: nodeId },
				revision: 1,
				pendingArchive: { fromPath: browserFile.path },
				size: 0,
				updatedAt: Date.now(),
			}),
		);
		const prepared = await prepare_browser_file(t, scope);
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect(finalized._yay?.path).toBe("/reports/capture-2.bin");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).toBeNull();
	});

	test("reads across same-tenant threads and refuses cross-tenant reads and discarded replay", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const prepared = await prepare_browser_file(t, scope);
		const finalArgs = { ...scope, receiptId: prepared.receiptId, attemptId: browserFile.attemptId };
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, finalArgs);
		if (finalized._nay) throw new Error(finalized._nay.message);
		const target = finalized._yay.target;
		const threadId = await t.run(async (ctx) => {
			const thread = await ctx.db.get("ai_chat_threads", scope.threadId);
			const { _id: _id, _creationTime: _time, ...fields } = thread!;
			return await ctx.db.insert("ai_chat_threads", { ...fields, clientGeneratedId: "branch-files" });
		});
		const readArgs = {
			userId: scope.userId,
			membershipId: scope.membershipId,
			threadId,
			path: finalized._yay.path,
			target,
		};
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay).toBeDefined();
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { organizationId: "other-tenant" }));
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._nay).toBeDefined();
		const asUser = authed(t, scope.userId);
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: scope.membershipId,
					target,
					pendingUpdateId: view!.entry.pendingUpdate!._id,
					reviewedRevision: view!.entry.pendingUpdate!.revision,
				})
			)._nay,
		).toBeUndefined();
		expect((await t.mutation(internal.files_browser.finalize_file_output, finalArgs))._nay).toBeDefined();
	});

	test("keeps the first hold when a later item exceeds private byte quota", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...scope, quotaName: "files_private_user_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 8 });
		});
		const first = await prepare_browser_file(t, scope);
		await expect(
			t.mutation(internal.files_browser.prepare_file_output, {
				...scope,
				...browserFile,
				requestId: "file-output-2",
			}),
		).rejects.toThrow("pending files");
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", first.assetId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toHaveLength(1);
	});
});

describe("get_file_read_source", () => {
	test("keeps pending files owner-only and uses current saved grants through the old private ID", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const path = "/reports/shared.bin";
		const prepared = await prepare_browser_file(t, scope, { path });
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: browserFile.attemptId,
		});
		if (finalized._nay) throw new Error(finalized._nay.message);

		const target = finalized._yay.target;

		// A second member of the same workspace. A capture is still a private draft, so this member
		// cannot read it, whatever their workspace role says.
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, { ...scope, userId, role: "member", now: Date.now() });
			return { userId, membershipId };
		});
		const memberRead = { ...member, threadId: scope.threadId, path, target };
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._nay).toBeDefined();

		const asOwner = authed(t, scope.userId);
		const view = await asOwner.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		for (const parent of view!.requiredParents) {
			expect(
				(
					await asOwner.action(api.files_pending_updates.save_file_pending_update, {
						membershipId: scope.membershipId,
						target: parent.target,
						pendingUpdateId: parent.pendingUpdateId,
						reviewedRevision: parent.reviewedRevision,
					})
				)._nay,
			).toBeUndefined();
		}
		const saved = await asOwner.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: scope.membershipId,
			target,
			pendingUpdateId: view!.entry.pendingUpdate!._id,
			reviewedRevision: view!.entry.pendingUpdate!.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved file");
		const nodeId = saved._yay.target.id;

		// After Save the member reads the file through the same old private target, and their access
		// follows the saved file's current sharing from here on.
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._yay?.target).toEqual(
			saved._yay.target,
		);

		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: scope.membershipId, nodeId }))._nay,
		).toBeUndefined();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._nay).toBeDefined();
		expect(
			(
				await asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: scope.membershipId,
					nodeId,
					principal: { kind: "user", userId: member.userId },
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._yay).toBeDefined();
		expect(
			(
				await asOwner.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: scope.membershipId,
					nodeId,
					principal: { kind: "user", userId: member.userId },
				})
			)._nay,
		).toBeUndefined();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._nay).toBeDefined();

		// A user from another tenant never reads the file, whatever the sharing says.
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-file-reader" }),
		);
		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: other.userId,
					membershipId: other.membershipId,
					threadId: scope.threadId,
					path,
					target: saved._yay.target,
				})
			)._nay,
		).toBeDefined();

		// An archived file is gone for its owner too, so the old private target stops working.
		await t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { archiveOperationId: "archived" }));
		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: scope.userId,
					membershipId: scope.membershipId,
					threadId: scope.threadId,
					path,
					target,
				})
			)._nay,
		).toBeDefined();
	});

	test("refuses the file immediately when normal pending expiry fences it", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const path = "/reports/expired.bin";
		const prepared = await prepare_browser_file(t, scope, { path });
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: browserFile.attemptId,
		});
		if (finalized._nay) throw new Error(finalized._nay.message);

		const target = finalized._yay.target;
		const view = await authed(t, scope.userId).query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		const pendingUpdateId = view!.entry.pendingUpdate!._id;

		// A proposal is cleaned up four hours after its last write. Move the capture's proposal past
		// that age and run the cleanup, and the reader must lose the file with it.
		const expiredAt = Date.now() - 4 * 60 * 60 * 1000 - 1;
		await t.run((ctx) => ctx.db.patch("files_pending_updates", pendingUpdateId, { updatedAt: expiredAt }));
		await t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
			pendingUpdateId,
			expectedUpdatedAt: expiredAt,
		});

		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: scope.userId,
					membershipId: scope.membershipId,
					threadId: scope.threadId,
					path,
					target,
				})
			)._nay,
		).toBeDefined();
	});
});

describe("start_browser", () => {
	test.each(["/page.html", "/other.html"])("replaces an expired runner before starting %s", async (path) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session(t, fixture);
		const nodeId =
			path === fixture.path
				? fixture.nodeId
				: await test_create_saved_text_file(t, {
						membershipId: fixture.membershipId,
						path,
						textContent: HTML_TEXT,
					});
		runnerQueue.push({ ok: true, alive: false });
		const next = await start_saved_session(t, { ...fixture, nodeId, path });
		expect(next._nay).toBeUndefined();
		expect(next._yay?.sessionId).not.toBe(first._yay?.sessionId);
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", first._yay!.sessionId)))?.control).toBe("closed");
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status", "open"]);
	});

	test("keeps a live runner when only the mirrored idle deadline is old", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session(t, fixture);
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", first._yay!.sessionId, { idleUntil: Date.now() - 1 }));
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true });
		const next = await start_saved_session(t, fixture);
		expect(next._yay?.sessionId).toBe(first._yay?.sessionId);
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
	});

	test("preserves the slot when a status request cannot reach the runner", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session(t, fixture);
		vi.mocked(fetch).mockRejectedValueOnce(new Error("network unavailable"));
		const next = await start_saved_session(t, fixture);
		expect(next._nay?.message).toBe("Browser request failed");
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", first._yay!.sessionId)))?.control).toBe("ready");
	});

	test("rejects unauthenticated callers", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const result = await t.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(result._nay?.message).toBe("Unauthenticated");
		expect(runnerCalls).toEqual([]);
	});

	test("starts a saved session and sends the committed bytes", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const result = await start_saved_session(t, fixture);
		expect(result._nay).toBeUndefined();
		expect(result._yay).toMatchObject({
			nodeId: fixture.nodeId,
			sourceKind: "saved",
			loadGen: 1,
			controlGen: 1,
			control: "ready",
		});
		expect(runnerCalls.length).toBe(1);
		expect(runnerCalls[0]?.route).toBe("open");
		expect(runnerCalls[0]?.body.html).toBe(HTML_TEXT);
		expect(runnerCalls[0]?.body.sourceKind).toBe("saved");

		const stored = await t.run((ctx) => ctx.db.get("files_browser_sessions", result._yay!.sessionId));
		expect(stored).toMatchObject({
			ownerId: fixture.userId,
			nodeId: fixture.nodeId,
			control: "ready",
			runnerSessionId: "runner-session-1",
		});
	});

	test("returns busy for another file while one is live", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		await start_saved_session(t, fixture);

		const otherId = await test_create_saved_text_file(t, {
			membershipId: fixture.membershipId,
			path: "/other.html",
			textContent: HTML_TEXT,
		});
		const asUser = authed(t, fixture.userId);
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true });
		const busy = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: otherId,
			path: "/other.html",
			sourceKind: "saved",
			navigationGeneration: 2,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(busy._nay?.message).toBe("Browser busy");
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
	});

	test("reattaches the same live file without opening again", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session(t, fixture);
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true });
		const second = await start_saved_session(t, fixture);
		expect(second._yay?.sessionId).toBe(first._yay?.sessionId);
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
	});

	test("refuses a non-html file", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const textId = await test_create_saved_text_file(t, {
			membershipId: fixture.membershipId,
			path: "/notes.txt",
			textContent: "plain",
		});
		const asUser = authed(t, fixture.userId);
		const result = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: textId,
			path: "/notes.txt",
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(result._nay?.message).toBe("Choose an available source.");
		expect(runnerCalls).toEqual([]);
	});

	test("cleans the starting doc when the runner refuses", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		runnerQueue.push({ ok: false, error: { code: "busy", message: "busy" } });
		const asUser = authed(t, fixture.userId);
		const result = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(result._nay?.message).toBe("Browser did not start");
		const docs = await t.run((ctx) => ctx.db.query("files_browser_sessions").collect());
		expect(docs).toEqual([]);
	});

	test("reattach with a different source kind reports busy", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		await start_saved_session(t, fixture);

		const asUser = authed(t, fixture.userId);
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true });
		const second = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "proposed",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(second._nay?.message).toBe("Browser busy");
	});

	test("proposed start without a proposal is unavailable", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "proposed",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(started._nay).not.toBeUndefined();
		expect(runnerCalls).toEqual([]);
	});

	test("draft start without capture ids asks for a source", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(started._nay?.message).toBe("Choose an available source.");
		expect(runnerCalls).toEqual([]);
	});
});

describe("browser_source_current_version", () => {
	test("changes the saved version and snapshot key after a collaborative edit", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const args = {
			membershipId: fixture.membershipId,
			nodeId: String(fixture.nodeId),
			path: fixture.path,
			sourceKind: "saved" as const,
		};
		const before = await asUser.query(api.files_browser.browser_source_current_version, args);
		const node = (await t.run((ctx) => ctx.db.get("files_nodes", fixture.nodeId)))!;
		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text: "<p>Edited</p>" });
		if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			expectedYjsLastSequenceId: node.yjsLastSequenceId!,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: "browser-version-edit",
		});
		yjsDoc.destroy();
		expect(pushed._nay).toBeUndefined();
		const after = await asUser.query(api.files_browser.browser_source_current_version, args);
		expect(after?.version).not.toBe(before?.version);
		expect(after?.snapshotKey).not.toBe(before?.snapshotKey);
	});
});

describe("set_browser_control", () => {
	test.each([
		{ control: "human", controlGen: 4, nextControl: "ready", nextGen: 3 },
		{ control: "human", controlGen: 4, nextControl: "pausing", nextGen: 4 },
		{ control: "closing", controlGen: 4, nextControl: "human", nextGen: 5 },
	] as const)(
		"keeps $control/$controlGen against a delayed $nextControl/$nextGen reply",
		async ({ control, controlGen, nextControl, nextGen }) => {
			const t = test_convex();
			const fixture = await seed_html_file(t);
			const started = await start_saved_session(t, fixture);
			const sessionId = started._yay!.sessionId;
			await t.run((ctx) => ctx.db.patch("files_browser_sessions", sessionId, { control, controlGen }));
			await t.mutation(internal.files_browser.set_browser_control, {
				sessionId,
				control: nextControl,
				controlGen: nextGen,
			});
			expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
				control,
				controlGen,
			});
		},
	);

	test("finishes a pausing handoff within the same generation", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", sessionId, { control: "pausing", controlGen: 2 }));
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "human", controlGen: 2 });
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			control: "human",
			controlGen: 2,
		});
	});
});

describe("reload_browser", () => {
	test("copies the runner generation and source instead of counting local reloads", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push(
			runner_open_session({ nodeId: fixture.nodeId, loadGen: 7, sourceVersion: "loaded-7", sourceHash: "hash-7" }),
		);
		const reloaded = await authed(t, fixture.userId).action(api.files_browser.reload_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			path: fixture.path,
		});
		expect(reloaded._yay).toEqual({
			controlGen: 1,
			navGen: 1,
			loadGen: 7,
			sourceVersion: "loaded-7",
			sourceHash: "hash-7",
		});
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId))).toMatchObject({
			controlGen: 1,
			navigationGeneration: 1,
			loadGen: 7,
			sourceVersion: "loaded-7",
			sourceHash: "hash-7",
		});
	});

	test("does not update the source after an incomplete runner reply", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: true });
		const reloaded = await authed(t, fixture.userId).action(api.files_browser.reload_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			path: fixture.path,
		});
		expect(reloaded._nay).toBeDefined();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.loadGen).toBe(1);
	});

	test("keeps the agent lease through the source read and runner reload", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const expectedAgentLease = { controlGen: 1, loadGen: 1, navGen: 1 };
		runnerQueue.push({ ok: false, error: { code: "stale_control", message: "Control changed" } });
		const reloaded = await authed(t, fixture.userId).action(api.files_browser.reload_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			path: fixture.path,
			expectedAgentLease,
		});
		expect(reloaded._nay).toBeDefined();
		expect(runnerCalls[1]?.body.expectedAgentLease).toEqual(expectedAgentLease);
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.loadGen).toBe(1);
	});
});

describe("sync_browser_session", () => {
	test("merges source and control separately when replies arrive out of order", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		const runner = runner_open_session({ nodeId: fixture.nodeId }).session;
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "human", controlGen: 4 });
		const newerSource = { ...runner, loadGen: 7, sourceVersion: "loaded-7", sourceHash: "hash-7" };
		await t.mutation(internal.files_browser.sync_browser_session, { sessionId, runner: newerSource });
		await t.mutation(internal.files_browser.sync_browser_session, { sessionId, runner: { ...runner, controlGen: 5 } });
		await t.mutation(internal.files_browser.sync_browser_session, { sessionId, runner: newerSource });
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			loadGen: 7,
			sourceVersion: "loaded-7",
			sourceHash: "hash-7",
			control: "ready",
			controlGen: 5,
		});
	});

	test.each(["human", "ready"] as const)("keeps the final %s state after a delayed pausing reply", async (control) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		const runner = { ...runner_open_session({ nodeId: fixture.nodeId }).session, controlGen: 2 };
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "pausing", controlGen: 2 });
		await t.mutation(internal.files_browser.sync_browser_session, { sessionId, runner: { ...runner, control } });
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "pausing", controlGen: 2 });
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.control).toBe(control);
	});

	test.each([
		{ sessionId: "another-runner" },
		{ nodeId: "another-file" },
		{ navGen: 2 },
		{ sourceKind: "draft" as const },
	])("rejects metadata for a different binding: %j", async (changed) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		const synced = await t.mutation(internal.files_browser.sync_browser_session, {
			sessionId,
			runner: { ...runner_open_session({ nodeId: fixture.nodeId, loadGen: 7 }).session, ...changed },
		});
		expect(synced._nay).toBeDefined();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.loadGen).toBe(1);
	});

	test.each(["closing", "closed"] as const)("does not reopen a %s session", async (control) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", sessionId, { control }));
		const synced = await t.mutation(internal.files_browser.sync_browser_session, {
			sessionId,
			runner: runner_open_session({ nodeId: fixture.nodeId, loadGen: 7, controlGen: 5 }).session,
		});
		expect(synced._yay).toBeNull();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.control).toBe(control);
	});
});

describe("/api/chat browser binding", () => {
	async function send_chat(
		t: ReturnType<typeof test_convex>,
		fixture: BrowserFixture,
		sessionId: Id<"files_browser_sessions">,
	) {
		const asUser = authed(t, fixture.userId);
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: fixture.membershipId,
			clientGeneratedId: "browser-thread",
			title: "Browser",
			lastMessageAt: Date.now(),
		});
		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				membershipId: fixture.membershipId,
				browserSessionId: sessionId,
				threadId: thread._yay!.threadId,
				messages: [{ id: "browser-message", role: "user", parts: [{ type: "text", text: "Inspect the page." }] }],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
			}),
		});
		expect(response.status, await response.text()).toBe(200);
		return model.streamText.mock.calls[0][0] as Parameters<typeof streamText>[0];
	}

	test("takes the initial lease and disables only browser tools after another takeover", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "human", controlGen: 2 });
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId, controlGen: 3, loadGen: 7 }), alive: true });
		const call = await send_chat(t, fixture, sessionId);
		expect(call.tools).toHaveProperty("browser_run");
		if (!call.prepareStep) throw new Error("Expected prepareStep");
		const step = {
			model: call.model,
			messages: call.messages ?? [],
			steps: [],
			stepNumber: 0,
			experimental_context: call.experimental_context,
		};
		await t.run(async () => {
			expect(await call.prepareStep!(step)).toEqual({ messages: step.messages });
		});
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "ready", controlGen: 4 });
		await t.run(async () => {
			const next = await call.prepareStep!({ ...step, stepNumber: 1 });
			expect(next?.activeTools).toContain("bash");
			expect(next?.activeTools).not.toContain("browser_run");
			expect(next?.activeTools).not.toContain("browser_reload");
			expect(next?.activeTools).not.toContain("browser_close");
			expect(next?.system).toContain("no longer available");
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
	});

	test("keeps browser tools available after their own acknowledged reload", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true });
		const call = await send_chat(t, fixture, sessionId);
		const reload = call.tools?.browser_reload;
		if (!reload?.execute || !call.prepareStep) throw new Error("Expected live browser tools");
		runnerQueue.push(runner_open_session({ nodeId: fixture.nodeId, loadGen: 2 }));
		await authed(t, fixture.userId).run(async () => {
			expect(await reload.execute!({}, { toolCallId: "reload", messages: [] })).toMatchObject({
				metadata: { status: "succeeded", reason: null },
			});
			const next = await call.prepareStep!({
				model: call.model,
				messages: call.messages ?? [],
				steps: [],
				stepNumber: 1,
				experimental_context: call.experimental_context,
			});
			expect(next?.activeTools).toBeUndefined();
			expect(next?.system).toBeUndefined();
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status", "reload"]);
	});

	test.each([
		{ reply: { ok: true, alive: false }, control: "closed" },
		{ reply: { ok: false, error: { code: "offline", message: "Unavailable" } }, control: "ready" },
		{ reply: { ok: true, alive: true }, control: "ready" },
	])("omits browser tools after an unavailable status: $reply", async ({ reply, control }) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		runnerQueue.push(reply);
		const call = await send_chat(t, fixture, sessionId);
		expect(call.tools).not.toHaveProperty("browser_run");
		expect(call.system).toContain("unavailable for this request");
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.control).toBe(control);
	});
});

describe("capture_browser_draft", () => {
	test("captures and starts a draft without saving the file", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const draftHtml = HTML_TEXT.replace("Hi", "Draft");
		const hash = await sha256_hex(draftHtml);

		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 7,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(draftHtml).byteLength,
			hash,
		});
		expect(captured._nay).toBeUndefined();
		expect(typeof captured._yay?.uploadUrl).toBe("string");

		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([draftHtml])));
		const attached = await asUser.mutation(api.files_browser.attach_draft_capture_blob, {
			membershipId: fixture.membershipId,
			captureId: captured._yay!.captureId,
			storageId,
		});
		expect(attached._nay).toBeUndefined();

		runnerQueue.push(runner_open_session({ sourceKind: "draft" }));
		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
			draftCaptureId: captured._yay!.captureId,
			draftStorageId: storageId,
			draftRevisionAfter: 7,
		});
		expect(started._nay).toBeUndefined();
		expect(started._yay?.sourceKind).toBe("draft");
		expect(runnerCalls[0]?.body.html).toBe(draftHtml);

		// One-shot: the capture and its blob are gone, the file is untouched.
		expect(await t.run((ctx) => ctx.db.get("files_browser_draft_captures", captured._yay!.captureId))).toBe(null);
		expect(await t.run((ctx) => ctx.storage.get(storageId))).toBe(null);
	});

	test("refuses an edit that lands mid-capture", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);

		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 7,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		});
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([HTML_TEXT])));
		await asUser.mutation(api.files_browser.attach_draft_capture_blob, {
			membershipId: fixture.membershipId,
			captureId: captured._yay!.captureId,
			storageId,
		});

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
			draftCaptureId: captured._yay!.captureId,
			draftStorageId: storageId,
			draftRevisionAfter: 8,
		});
		expect(started._nay?.message).toBe("The draft changed while loading. Refresh to try again.");
		expect(runnerCalls).toEqual([]);
	});

	test("tampered draft bytes fail the hash check", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);

		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 7,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		});
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([HTML_TEXT.replace("Hi", "Tampered")])));
		await asUser.mutation(api.files_browser.attach_draft_capture_blob, {
			membershipId: fixture.membershipId,
			captureId: captured._yay!.captureId,
			storageId,
		});

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
			draftCaptureId: captured._yay!.captureId,
			draftStorageId: storageId,
			draftRevisionAfter: 7,
		});
		expect(started._nay?.message).toBe("Choose an available source.");
		expect(runnerCalls).toEqual([]);
	});

	test("daily capture cap refuses the 101st capture", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);
		const base = {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		} as const;

		for (let revision = 1; revision <= 100; revision++) {
			const captured = await asUser.mutation(api.files_browser.capture_browser_draft, { ...base, revision });
			expect(captured._nay, `capture ${revision}`).toBeUndefined();
		}
		const capped = await asUser.mutation(api.files_browser.capture_browser_draft, { ...base, revision: 101 });
		expect(capped._nay?.message).toBe("Daily browser capture limit reached.");
	});
});

describe("end_browser", () => {
	test("closes the session when the runner accepts the agent lease", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: true, existed: true, verified: true });
		const ended = await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			expectedAgentLease: { controlGen: 1, loadGen: 1, navGen: 1 },
		});
		expect(ended._nay).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.control).toBe(
			"closed",
		);
	});

	test("refuses agent close after human takeover before calling the runner", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		await t.mutation(internal.files_browser.set_browser_control, {
			sessionId: started._yay!.sessionId,
			control: "human",
			controlGen: 2,
		});
		const ended = await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			expectedAgentLease: { controlGen: 1, loadGen: 1, navGen: 1 },
		});
		expect(ended._nay?.message).toBe("Browser control changed");
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.control).toBe(
			"human",
		);
	});

	test("keeps the session open when the runner refuses an old agent lease", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const expectedAgentLease = { controlGen: 1, loadGen: 1, navGen: 1 };
		runnerQueue.push({ ok: false, error: { code: "stale_control", message: "Control changed" } });
		const ended = await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			expectedAgentLease,
		});
		expect(ended._nay).toBeDefined();
		expect(runnerCalls[1]?.body.expectedAgentLease).toEqual(expectedAgentLease);
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.control).toBe(
			"ready",
		);
	});

	test("closes the runner session and marks the doc closed", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: true, existed: true, verified: true });

		const asUser = authed(t, fixture.userId);
		const ended = await asUser.action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
		});
		expect(ended._nay).toBeUndefined();
		expect(runnerCalls[1]?.route).toBe("close");
		expect(runnerCalls[1]?.body.sessionId).toBe("runner-session-1");
		const stored = await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId));
		expect(stored?.control).toBe("closed");
	});

	test("marks closed even when the runner call fails", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: false, error: { code: "error", message: "boom" } });

		const asUser = authed(t, fixture.userId);
		const ended = await asUser.action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
		});
		expect(ended._nay).toBeUndefined();
		const stored = await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId));
		expect(stored?.control).toBe("closed");
	});
});

describe("current_browser_session", () => {
	test("returns the live session and null after end", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		expect(await asUser.query(api.files_browser.current_browser_session, { membershipId: fixture.membershipId })).toBe(
			null,
		);

		const started = await start_saved_session(t, fixture);
		const current = await asUser.query(api.files_browser.current_browser_session, {
			membershipId: fixture.membershipId,
		});
		expect(current?.sessionId).toBe(started._yay?.sessionId);
		expect(current).not.toHaveProperty("runnerSessionId");

		runnerQueue.push({ ok: true, existed: true, verified: true });
		await asUser.action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
		});
		expect(await asUser.query(api.files_browser.current_browser_session, { membershipId: fixture.membershipId })).toBe(
			null,
		);
	});
});

describe("viewer and control doors", () => {
	test("retires the session when a failed viewer grant confirms the runner is gone", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: false, error: { code: "closed", message: "The browser session is closed." } });
		runnerQueue.push({ ok: true, alive: false });
		const granted = await authed(t, fixture.userId).action(api.files_browser.grant_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
		});
		expect(granted._nay).toBeDefined();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.control).toBe(
			"closed",
		);
	});

	test("retires the session when a failed renewal confirms the runner is gone", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: false, error: { code: "viewer", message: "The viewer is gone." } });
		runnerQueue.push({ ok: true, alive: false });
		const asUser = authed(t, fixture.userId);
		const renewed = await asUser.action(api.files_browser.renew_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			viewerId: "viewer-1",
		});
		expect(renewed._nay).toBeDefined();
		expect(await asUser.query(api.files_browser.current_browser_session, { membershipId: fixture.membershipId })).toBe(
			null,
		);
	});

	test.each([true, null])("keeps the session after a renewal failure when liveness is %s", async (alive) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		runnerQueue.push({ ok: false, error: { code: "viewer", message: "The viewer is gone." } });
		runnerQueue.push(
			alive === null
				? { ok: false, error: { code: "offline", message: "Unavailable" } }
				: { ...runner_open_session({ nodeId: fixture.nodeId }), alive },
		);
		await authed(t, fixture.userId).action(api.files_browser.renew_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			viewerId: "viewer-1",
		});
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId)))?.control).toBe(
			"ready",
		);
	});

	test("grants, renews, takes, and resumes with doc mirrors", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const asUser = authed(t, fixture.userId);
		const sessionId = started._yay!.sessionId;

		runnerQueue.push({ ok: true, grantId: "grant-1", expiresAt: Date.now() + 30_000 });
		const granted = await asUser.action(api.files_browser.grant_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId,
		});
		expect(granted._yay?.grantId).toBe("grant-1");

		runnerQueue.push({
			ok: true,
			grantedUntil: Date.now() + 30_000,
			session: runner_open_session({ nodeId: fixture.nodeId }).session,
		});
		const renewed = await asUser.action(api.files_browser.renew_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId,
			viewerId: "viewer-1",
		});
		expect(renewed._yay?.control).toBe("ready");

		runnerQueue.push({ ok: true, control: "human", controlGen: 2 });
		const taken = await asUser.action(api.files_browser.take_browser_control, {
			membershipId: fixture.membershipId,
			sessionId,
			viewerId: "viewer-1",
		});
		expect(taken._yay).toEqual({ control: "human", controlGen: 2 });
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.control).toBe("human");

		runnerQueue.push({ ok: true, control: "ready", controlGen: 3 });
		const threadId = await t.run((ctx) =>
			ctx.db.insert("ai_chat_threads", {
				organizationId: fixture.organizationId as unknown as string,
				workspaceId: fixture.workspaceId as unknown as string,
				clientGeneratedId: "thread-1",
				title: null,
				archived: false,
				runtime: "aisdk_5",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: Date.now(),
			}),
		);
		const resumed = await asUser.action(api.files_browser.resume_browser_agent, {
			membershipId: fixture.membershipId,
			sessionId,
			threadId,
		});
		expect(resumed._nay).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.control).toBe("ready");
	});

	test("renew mirrors the runner idle deadline", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		const idleUntil = Date.now() + 310_000;

		runnerQueue.push({
			ok: true,
			grantedUntil: Date.now() + 30_000,
			session: runner_open_session({ nodeId: fixture.nodeId, idleUntil }).session,
		});
		const asUser = authed(t, fixture.userId);
		const renewed = await asUser.action(api.files_browser.renew_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId,
			viewerId: "viewer-1",
		});
		expect(renewed._nay).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.idleUntil).toBe(idleUntil);
	});
});

describe("cleanup_expired_browser_docs", () => {
	test.each(["starting", "closing", "closed"] as const)(
		"reaches an expired %s start behind a full batch of retained sessions",
		async (control) => {
			const t = test_convex();
			const fixture = await seed_html_file(t);
			const startingId = await t.run(async (ctx) => {
				const session = {
					ownerId: fixture.userId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					targetKind: "saved" as const,
					nodeId: String(fixture.nodeId),
					path: fixture.path,
					navigationClientId: "client-1",
					navigationGeneration: 1,
					sourceKind: "saved" as const,
					sourceVersion: "v1",
					sourceHash: "hash",
					loadGen: 1,
					controlGen: 1,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				// These 50 closed just now, so the sweep keeps them. They also fill one whole sweep
				// batch, so the expired session below is only reached through its own deadline index.
				for (let index = 0; index < 50; index++) {
					await ctx.db.insert("files_browser_sessions", { ...session, control: "closed", closedAt: Date.now() });
				}

				return await ctx.db.insert("files_browser_sessions", {
					...session,
					control,
					closedAt: control === "closed" ? Date.now() : undefined,
					startingExpiresAt: Date.now() - 1,
				});
			});

			await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});

			expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", startingId))).toBe(null);
			expect(await t.run((ctx) => ctx.db.query("files_browser_sessions").collect())).toHaveLength(50);
		},
	);

	test("deletes old closed sessions and daily counters while keeping recent ones", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		// A closed session is kept for 7 days and a daily counter for 2 days. So this 8-day-old session
		// and this 3-day-old counter must go, while the session closed just now stays.
		const recentId = await t.run(async (ctx) => {
			const { _id, _creationTime, ...session } = (await ctx.db.get("files_browser_sessions", sessionId))!;
			await ctx.db.patch("files_browser_sessions", sessionId, {
				control: "closed",
				closedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
			});

			await ctx.db.insert("files_browser_daily_use", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				day: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
				starts: 1,
				captures: 0,
				updatedAt: Date.now(),
			});
			return await ctx.db.insert("files_browser_sessions", { ...session, control: "closed", closedAt: Date.now() });
		});

		await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});

		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", recentId))).not.toBe(null);

		// Only today's counter is left. The start above created it.
		const counters = await t.run((ctx) => ctx.db.query("files_browser_daily_use").collect());
		expect(counters).toHaveLength(1);
		expect(counters[0]?.day).toBe(new Date().toISOString().slice(0, 10));
	});

	test("sweep deletes expired captures and starting sessions", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);
		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 1,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		});
		const captureId = captured._yay!.captureId;
		await t.run((ctx) => ctx.db.patch("files_browser_draft_captures", captureId, { expiresAt: Date.now() - 1 }));
		const created = await t.mutation(internal.files_browser.create_starting_browser_session, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: String(fixture.nodeId),
			path: fixture.path,
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewportWidth: 1280,
			viewportHeight: 900,
		});
		const startingId = created._yay!.sessionId;
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", startingId, { startingExpiresAt: Date.now() - 1 }));

		await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});
		expect(await t.run((ctx) => ctx.db.get("files_browser_draft_captures", captureId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", startingId))).toBe(null);
	});
});

describe("access loss and daily caps", () => {
	test("viewer grant closes the session when the file is gone", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		expect(started._nay).toBeUndefined();
		const sessionId = started._yay!.sessionId;

		await t.run((ctx) => ctx.db.delete("files_nodes", fixture.nodeId));

		runnerQueue.push({ ok: true, existed: true, verified: true });
		const asUser = authed(t, fixture.userId);
		const granted = await asUser.action(api.files_browser.grant_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId,
		});
		expect(granted._nay).not.toBeUndefined();
		const session = await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId));
		expect(session?.control).toBe("closed");
	});

	test("viewer grant refuses a starting session without calling the runner", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const created = await t.mutation(internal.files_browser.create_starting_browser_session, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: String(fixture.nodeId),
			path: fixture.path,
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewportWidth: 1280,
			viewportHeight: 900,
		});
		expect(created._nay).toBeUndefined();

		runnerQueue.push({ ok: true, grantId: "unused", expiresAt: Date.now() + 30_000 });
		const granted = await asUser.action(api.files_browser.grant_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId: created._yay!.sessionId,
		});
		expect(granted._nay?.message).toBe("Not found");
		expect(runnerQueue.length).toBe(1);
	});

	test("reload follows a rename through the node id", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		expect(started._nay).toBeUndefined();

		await t.run((ctx) => ctx.db.patch("files_nodes", fixture.nodeId, { path: "/renamed.html", name: "renamed.html" }));

		runnerQueue.push(runner_open_session({ nodeId: fixture.nodeId, loadGen: 2 }));
		const asUser = authed(t, fixture.userId);
		const reloaded = await asUser.action(api.files_browser.reload_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
			path: fixture.path,
		});
		expect(reloaded._nay).toBeUndefined();
		expect(reloaded._yay?.loadGen).toBe(2);
	});

	test("daily start cap refuses the 31st fresh start", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const base = {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: String(fixture.nodeId),
			path: fixture.path,
			sourceKind: "saved",
			navigationClientId: "client-1",
			viewportWidth: 1280,
			viewportHeight: 900,
		} as const;

		for (let nav = 1; nav <= 30; nav++) {
			const created = await t.mutation(internal.files_browser.create_starting_browser_session, {
				...base,
				navigationGeneration: nav,
			});
			expect(created._nay, `start ${nav}`).toBeUndefined();
			await t.mutation(internal.files_browser.delete_starting_browser_session, {
				sessionId: created._yay!.sessionId,
			});
		}
		const capped = await t.mutation(internal.files_browser.create_starting_browser_session, {
			...base,
			navigationGeneration: 31,
		});
		expect(capped._nay?.message).toBe("Daily browser start limit reached.");
	});
});

describe("private sources", () => {
	test("starts a pending HTML proposal without saving it", async () => {
		const t = test_convex();
		const fixture = await seed_private_html_file(t);
		runnerQueue.push(
			runner_open_session({
				nodeId: fixture.nodeId,
				sourceKind: "proposed",
				sourceVersion: `pending:${fixture.nodeId}`,
			}),
		);

		const asUser = authed(t, fixture.userId);
		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "private",
			nodeId: String(fixture.nodeId),
			path: fixture.path,
			sourceKind: "proposed",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(started._nay).toBeUndefined();
		expect(started._yay?.targetKind).toBe("private");
		expect(started._yay?.sourceVersion).toContain(String(fixture.nodeId));
		expect(runnerCalls[0]?.body.html).toContain("<p>Hi</p>");
	});

	test("private target with a saved source is unavailable", async () => {
		const t = test_convex();
		const fixture = await seed_private_html_file(t);
		const asUser = authed(t, fixture.userId);

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "private",
			nodeId: String(fixture.nodeId),
			path: fixture.path,
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		expect(started._nay).not.toBeUndefined();
		expect(runnerCalls).toEqual([]);
	});
});

describe("rename and closing slot", () => {
	test("current session survives a rename through the live path", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		await start_saved_session(t, fixture);
		await t.run((ctx) => ctx.db.patch("files_nodes", fixture.nodeId, { path: "/renamed.html", name: "renamed.html" }));

		const asUser = authed(t, fixture.userId);
		const current = await asUser.query(api.files_browser.current_browser_session, {
			membershipId: fixture.membershipId,
		});
		expect(current?.nodeId).toBe(String(fixture.nodeId));
	});

	test("viewer grant survives a rename instead of ending the session", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		await t.run((ctx) => ctx.db.patch("files_nodes", fixture.nodeId, { path: "/renamed.html", name: "renamed.html" }));

		runnerQueue.push({ ok: true, grantId: "grant-1", expiresAt: Date.now() + 30_000 });
		const asUser = authed(t, fixture.userId);
		const granted = await asUser.action(api.files_browser.grant_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId,
		});
		expect(granted._yay?.grantId).toBe("grant-1");
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.control).toBe("ready");
	});

	test("current session skips a closing doc for the live one", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const staleId = started._yay!.sessionId;
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", staleId, { control: "closing" }));
		const liveId = await t.run((ctx) =>
			ctx.db.insert("files_browser_sessions", {
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				targetKind: "saved",
				nodeId: String(fixture.nodeId),
				path: fixture.path,
				navigationClientId: "client-1",
				navigationGeneration: 2,
				sourceKind: "saved",
				sourceVersion: "v1",
				sourceHash: "hash",
				loadGen: 1,
				controlGen: 1,
				control: "ready",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		const asUser = authed(t, fixture.userId);
		const current = await asUser.query(api.files_browser.current_browser_session, {
			membershipId: fixture.membershipId,
		});
		expect(current?.sessionId).toBe(String(liveId));
	});
});

describe("check_browser_source_access", () => {
	test("denies a private source after workspace read access is revoked", async () => {
		const t = test_convex();
		const fixture = await seed_private_html_file(t);
		runnerQueue.push(runner_open_session({ nodeId: fixture.nodeId, sourceKind: "proposed" }));
		const started = await authed(t, fixture.userId).action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "private",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "proposed",
			navigationGeneration: 1,
			navigationClientId: "private-access",
			viewport: { width: 1280, height: 900 },
		});
		if (started._nay) throw new Error(started._nay.message);
		const args = {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			membershipId: fixture.membershipId,
			sessionId: started._yay.sessionId,
		};
		expect((await t.query(internal.files_browser.check_browser_source_access, args)).ok).toBe(true);

		// Hand the organization to someone else. The user's read permission came from owning it, so
		// they lose access to their own draft while the running session still points at it.
		await t.run(async (ctx) => {
			const ownerUserId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", fixture.organizationId, { ownerUserId });
		});

		// The draft itself did not change. Only the access did, and the check must follow it.
		expect((await t.run((ctx) => ctx.db.get("files_pending_nodes", fixture.nodeId)))?.state).toBe("active");
		expect((await t.query(internal.files_browser.check_browser_source_access, args)).ok).toBe(false);
	});

	test("check denies a session whose node is gone", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		await t.run((ctx) => ctx.db.delete("files_nodes", fixture.nodeId));

		const checked = await t.query(internal.files_browser.check_browser_source_access, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			membershipId: fixture.membershipId,
			sessionId: started._yay!.sessionId,
		});
		expect(checked.ok).toBe(false);
	});
});

describe("keep_open_browser", () => {
	test("keep_open moves idle only, never the total", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		const before = (await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))!;

		runnerQueue.push({ ok: true, idleUntil: before.idleUntil! + 1000 });
		const asUser = authed(t, fixture.userId);
		const kept = await asUser.action(api.files_browser.keep_open_browser, {
			membershipId: fixture.membershipId,
			sessionId,
		});
		expect(kept._nay).toBeUndefined();
		const after = (await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))!;
		expect(after.idleUntil).toBeGreaterThan(before.idleUntil ?? 0);
		expect(after.totalUntil).toBe(before.totalUntil);
	});
});

describe("files_browser_db_delete_user_batch", () => {
	test("removes sessions and draft captures with their blobs", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const sessionId = await t.run((ctx) =>
			ctx.db.insert("files_browser_sessions", {
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				targetKind: "saved",
				nodeId: String(fixture.nodeId),
				path: fixture.path,
				navigationClientId: "client-1",
				navigationGeneration: 1,
				sourceKind: "saved",
				sourceVersion: "v1",
				sourceHash: "hash",
				loadGen: 1,
				controlGen: 1,
				control: "closed",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const captured = await authed(t, fixture.userId).mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 1,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash: await sha256_hex(HTML_TEXT),
		});
		const captureId = captured._yay!.captureId;
		const storageId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob([HTML_TEXT]));
			await ctx.db.patch("files_browser_draft_captures", captureId, { storageId });
			return storageId;
		});

		// Each call drains one family, so the sessions go first and the captures follow.
		const first = await t.run((ctx) =>
			files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 }),
		);
		expect(first.deletedCount).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_browser_draft_captures", captureId))).not.toBe(null);

		const second = await t.run((ctx) =>
			files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 }),
		);
		expect(second.deletedCount).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("files_browser_draft_captures", captureId))).toBe(null);
		// A capture's stored HTML goes with its doc. Nothing is left behind in storage.
		expect(await t.run((ctx) => ctx.storage.get(storageId))).toBe(null);

		const drained = await t.run((ctx) =>
			files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 }),
		);
		expect(drained).toEqual({ done: true, deletedCount: 0 });
	});
});
