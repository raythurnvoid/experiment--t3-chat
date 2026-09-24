/// <reference types="vite/client" />
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { streamText } from "ai";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import {
	files_browser_db_delete_profile,
	files_browser_db_delete_user_batch,
	files_browser_db_purge_workspace_batch,
} from "./files_browser.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_create_private_node_by_path } from "./files_nodes.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { r2_create_asset_key } from "./r2_client.ts";

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
				runnerCalls.push({ route: url.slice(url.indexOf("/internal/browser/") + "/internal/browser/".length), body });
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
			mode: "file" as const,
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

/**
 * Run `during` inside the next runner open call, before the runner replies. Other fetch calls keep
 * the normal mock. Use it to act while a start waits for the runner.
 *
 * The runner client swallows fetch errors, so a failed check inside `during` would not fail the
 * test. Await the returned function after the start to rethrow it.
 */
function during_next_runner_open(during: () => Promise<void>, reply: unknown) {
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("Expected the fetch mock");
	let ran: Promise<void> | null = null;
	vi.mocked(fetch).mockImplementation(async (input, init) => {
		if (ran || !String(input).endsWith("/internal/browser/open")) return await base(input, init);
		runnerCalls.push({ route: "open", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		ran = during();
		await ran.catch(() => {});
		return Response.json(reply);
	});
	return async () => {
		if (!ran) throw new Error("The runner open never ran");
		await ran;
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
	if (!session || session.mode !== "file") throw new Error("Expected a file browser session");

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

	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		membershipId: fixture.membershipId,
		userId: fixture.userId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	return {
		agentSource: {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			membershipId: fixture.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			threadId,
		},
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
			mode: "file" as const,
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
		// The pending `reports` folder sits at the root, so no saved folder is above the chain.
		expect(view!.savedParentId).toBeNull();
		expect(view!.entry.pendingUpdate?.createIntent).toMatchObject({ kind: "stored", size: 8 });
		expect(view!.entry.pendingUpdate?.threadIds).toEqual([scope.threadId]);
		const readArgs = {
			userId: scope.userId,
			membershipId: scope.membershipId,
			agentSource: scope.agentSource,
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
				expiresAt: Date.now() + 4 * 60 * 60 * 1000,
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
			agentSource: { ...scope.agentSource, threadId },
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
	test.each(["team leave and reinvite", "another user's chat", "archived chat", "third workspace"] as const)(
		"reads both roots but refuses %s without hiding home files from their owner",
		async (change) => {
			const t = test_convex();
			const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const home = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			const third = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { userId: home.userId, organizationName: "third-image-root" }),
			);
			const asOwner = authed(t, owner.userId);
			const asUser = authed(t, home.userId);
			const invite = { organizationId: owner.organizationId, workspaceId: owner.workspaceId, userIdToAdd: home.userId };
			expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
				_yay: null,
			});
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
					)
					.first(),
			);
			if (!membership) throw new Error("Expected team membership");
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				clientGeneratedId: "two-root-image-read",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				userId: home.userId,
				membershipId: membership._id,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const agentSource = {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: home.userId,
				membershipId: membership._id,
				membershipLifetime: captured._yay.membershipLifetime,
				threadId: thread._yay.threadId,
			};
			const path = "/image.png";
			const files = await t.run(async (ctx) => {
				const files = [];
				for (const destination of [captured._yay.current, home, third]) {
					const scope = {
						organizationId: destination.organizationId,
						workspaceId: destination.workspaceId,
						userId: home.userId,
					};
					const assetId = await ctx.db.insert("files_r2_assets", {
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						createdBy: home.userId,
						kind: "content",
						r2Bucket: "test",
						size: 8,
						updatedAt: Date.now(),
					});
					const r2Key = r2_create_asset_key({ ...scope, assetId });
					await ctx.db.patch("files_r2_assets", assetId, { r2Key });
					const reserved = await files_private_storage_db_reserve(ctx, {
						...scope,
						resource: { kind: "asset", id: assetId, r2Key },
						byteCount: 8,
					});
					if (reserved._nay) throw new Error(reserved._nay.message);
					const created = await files_nodes_db_create_private_node_by_path(ctx, {
						...scope,
						path,
						kind: "file",
						content: { kind: "stored", assetId, size: 8, contentType: "image/png" },
					});
					if (created._nay) throw new Error(created._nay.message);
					files.push({ membershipId: destination.membershipId, target: created._yay.target, assetId });
				}
				return files;
			});
			for (const file of files.slice(0, 2)) {
				const read = await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: home.userId,
					membershipId: file.membershipId,
					agentSource,
					path,
				});
				expect(read._yay).toMatchObject({ target: file.target, assetId: file.assetId });
			}
			if (change === "team leave and reinvite") {
				expect(
					await asUser.mutation(api.organizations.remove_user_from_organization, {
						organizationId: owner.organizationId,
						userIdToRemove: home.userId,
					}),
				).toEqual({ _yay: null });
				expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
					_yay: null,
				});
				const renewedMembership = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
						)
						.first(),
				);
				if (!renewedMembership) throw new Error("Expected renewed team membership");
				const renewed = await t.mutation(internal.ai_chat_workspaces.capture, {
					userId: home.userId,
					membershipId: renewedMembership._id,
				});
				if (renewed._nay) throw new Error(renewed._nay.message);
				expect(renewed._yay.membershipLifetime).not.toBe(agentSource.membershipLifetime);
				expect(
					(
						await t.query(internal.files_nodes_content.get_file_read_source, {
							userId: home.userId,
							membershipId: home.membershipId,
							agentSource: {
								...agentSource,
								membershipId: renewedMembership._id,
								membershipLifetime: renewed._yay.membershipLifetime,
							},
							path,
						})
					)._yay?.target,
				).toEqual(files[1]!.target);
			}
			if (change === "another user's chat")
				await t.run((ctx) => ctx.db.patch("ai_chat_threads", agentSource.threadId, { createdBy: owner.userId }));
			if (change === "archived chat")
				await t.run((ctx) => ctx.db.patch("ai_chat_threads", agentSource.threadId, { archived: true }));
			const selected = files[change === "third workspace" ? 2 : 1]!;
			for (const target of [undefined, selected.target])
				expect(
					await t.query(internal.files_nodes_content.get_file_read_source, {
						userId: home.userId,
						membershipId: selected.membershipId,
						agentSource,
						path,
						target,
					}),
				).toEqual({ _nay: { message: "File unavailable" } });
			// The source chat limits the agent, not the owner's regular Files view.
			const visible = await asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: selected.membershipId,
				target: selected.target,
			});
			expect(visible?.entry.node._id).toBe(selected.target.id);
		},
	);

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
			const { userId } = await test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, { ...scope, userId, role: "member", now: Date.now() });
			return { userId, membershipId };
		});
		const memberThread = await authed(t, member.userId).mutation(api.ai_chat.thread_create, {
			membershipId: member.membershipId,
			clientGeneratedId: "member-image-reader",
			lastMessageAt: Date.now(),
		});
		if (memberThread._nay) throw new Error(memberThread._nay.message);
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, member);
		if (captured._nay) throw new Error(captured._nay.message);
		const memberRead = {
			...member,
			agentSource: {
				...scope.agentSource,
				...member,
				threadId: memberThread._yay.threadId,
				membershipLifetime: captured._yay.membershipLifetime,
			},
			path,
			target,
		};
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
					agentSource: scope.agentSource,
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
					agentSource: scope.agentSource,
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

		const draft = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!draft?.expiresAt) throw new Error("Expected the pending draft expiry");
		vi.spyOn(Date, "now").mockReturnValue(draft.expiresAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
		});

		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: scope.userId,
					membershipId: scope.membershipId,
					agentSource: scope.agentSource,
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
		runnerQueue.push({ ok: true, alive: false, closing: false, usage: null, profileStored: false });
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
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
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

	// A paid owner would pay for an anonymous member's browser. File mode refuses it like web mode.
	test("refuses an anonymous user", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const result = await t
			.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: fixture.userId })
			.action(api.files_browser.start_browser, {
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
		expect(await t.run((ctx) => ctx.db.query("files_browser_sessions").collect())).toEqual([]);
	});

	test("bills the runner time when the file view ends the session during Start", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const acquiredAt = Date.now() - 20_000;
		const checkDuringOpen = during_next_runner_open(
			async () => {
				const starting = await t.run((ctx) => ctx.db.query("files_browser_sessions").first());
				if (!starting) throw new Error("Expected a starting doc");
				const ended = await authed(t, fixture.userId).action(api.files_browser.end_browser, {
					membershipId: fixture.membershipId,
					sessionId: starting._id,
				});
				expect(ended._nay).toBeUndefined();
			},
			runner_open_session({ nodeId: fixture.nodeId }),
		);
		runnerQueue.push({
			ok: true,
			existed: true,
			verified: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 20_000, reason: "closed" },
		});

		const started = await authed(t, fixture.userId).action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "saved",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
		});
		await checkDuringOpen();
		expect(started._nay?.message).toBe("The file changed. Refresh to try again.");
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "close"]);
		const docs = await t.run((ctx) => ctx.db.query("files_browser_sessions").collect());
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({
			control: "closed",
			runnerSessionId: "runner-session-1",
			billing: { state: "settled", billedMs: 20_000, amountCents: 0.3 },
		});
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
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
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
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
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
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
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
			mode: "file",
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
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId, controlGen: 3, loadGen: 7 }), alive: true, profileStored: false });
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
			expect(await call.prepareStep!(step)).toEqual({ activeTools: call.activeTools, messages: step.messages });
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
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
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
			expect(next?.activeTools).toEqual(call.activeTools);
			expect(next?.system).toBeUndefined();
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status", "reload"]);
	});

	test("drops web browser tools when the owner turns agent access off", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		runnerQueue.push({ ...runner_web_session(), alive: true, profileStored: false });
		const call = await send_chat(t, fixture, sessionId);
		expect(call.tools).toHaveProperty("browser_run");
		expect(call.system).toContain("You may navigate with `page.goto`.");
		if (!call.prepareStep) throw new Error("Expected prepareStep");

		// Change only the switch, not the control generation, so this proves the switch check itself.
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", sessionId, { agentAccess: false }));
		await t.run(async () => {
			const next = await call.prepareStep!({
				model: call.model,
				messages: call.messages ?? [],
				steps: [],
				stepNumber: 1,
				experimental_context: call.experimental_context,
			});
			expect(next?.activeTools).toContain("bash");
			expect(next?.activeTools).not.toContain("browser_run");
			expect(next?.system).toContain("no longer available");
		});
	});

	test.each([
		{ reply: { ok: true, alive: false, closing: false, usage: null, profileStored: false }, control: "closed" },
		{ reply: { ok: false, error: { code: "offline", message: "Unavailable" } }, control: "ready" },
		{ reply: { ok: true, alive: true, profileStored: false }, control: "ready" },
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
		runnerQueue.push({ ok: true, alive: false, closing: false, usage: null, profileStored: false });
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
		runnerQueue.push({ ok: true, alive: false, closing: false, usage: null, profileStored: false });
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
	test("deletes the download saves of an old settled session and keeps the saved file", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		const created = await t.mutation(internal.files_browser.create_browser_download_node, {
			...download_node_args(fixture, sessionId),
		});
		if (created._nay) throw new Error(created._nay.message);

		const oldAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
		await t.run((ctx) =>
			ctx.db.patch("files_browser_sessions", sessionId, {
				control: "closed",
				closedAt: oldAt,
				billing: { state: "settled", billedMs: 0, amountCents: 0, settledAt: oldAt },
				updatedAt: oldAt,
			}),
		);
		await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});

		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.query("files_browser_download_saves").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", created._yay.nodeId))).toMatchObject({
			archiveOperationId: null,
		});
	});

	test.each(["starting", "closing", "closed"] as const)(
		"reaches an expired %s start behind a full batch of retained sessions",
		async (control) => {
			const t = test_convex();
			const fixture = await seed_html_file(t);
			const startingId = await t.run(async (ctx) => {
				const session = {
					mode: "file" as const,
					ownerId: fixture.userId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					billedUserId: fixture.userId,
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
					await ctx.db.insert("files_browser_sessions", {
						...session,
						control: "closed",
						closedAt: Date.now(),
						billing: { state: "settled", billedMs: 0, amountCents: 0, settledAt: Date.now() },
					});
				}

				return await ctx.db.insert("files_browser_sessions", {
					...session,
					control,
					billing: { state: "pending" },
					closedAt: control === "closed" ? Date.now() : undefined,
					startingExpiresAt: Date.now() - 1,
				});
			});

			await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});

			expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", startingId))).toBe(null);
			expect(await t.run((ctx) => ctx.db.query("files_browser_sessions").collect())).toHaveLength(50);
		},
	);

	test("deletes old settled sessions and daily counters while keeping recent and unbilled ones", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
		const oldAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		// A settled session is kept for 7 days and a daily counter for 2 days. So this 8-day-old session
		// and these 3-day-old counters must go, while the session settled just now stays. An old session
		// that is still waiting for its bill also stays: the sweep must never drop unbilled time.
		const { recentId, pendingId } = await t.run(async (ctx) => {
			const { _id, _creationTime, ...session } = (await ctx.db.get("files_browser_sessions", sessionId))!;
			const settled = { state: "settled" as const, billedMs: 0, amountCents: 0, settledAt: oldAt };
			await ctx.db.patch("files_browser_sessions", sessionId, {
				control: "closed",
				closedAt: oldAt,
				billing: settled,
				updatedAt: oldAt,
			});

			await ctx.db.insert("files_browser_daily_use", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				day: threeDaysAgo,
				starts: 1,
				captures: 0,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("files_browser_user_daily_use", {
				userId: fixture.userId,
				day: threeDaysAgo,
				webStarts: 1,
				updatedAt: Date.now(),
			});
			const recentId = await ctx.db.insert("files_browser_sessions", {
				...session,
				control: "closed",
				closedAt: Date.now(),
				billing: { ...settled, settledAt: Date.now() },
				updatedAt: Date.now(),
			});
			const pendingId = await ctx.db.insert("files_browser_sessions", {
				...session,
				control: "closed",
				closedAt: oldAt,
				billing: { state: "pending" },
				updatedAt: oldAt,
			});
			return { recentId, pendingId };
		});

		await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});

		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", recentId))).not.toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", pendingId))).not.toBe(null);

		// Only today's counter is left. The start above created it.
		const counters = await t.run((ctx) => ctx.db.query("files_browser_daily_use").collect());
		expect(counters).toHaveLength(1);
		expect(counters[0]?.day).toBe(new Date().toISOString().slice(0, 10));
		expect(await t.run((ctx) => ctx.db.query("files_browser_user_daily_use").collect())).toEqual([]);
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
		expect(current?.mode === "file" ? current.nodeId : null).toBe(String(fixture.nodeId));
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
				mode: "file",
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				billedUserId: fixture.userId,
				billing: { state: "pending" },
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

describe("check_browser_session_access", () => {
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
		expect((await t.query(internal.files_browser.check_browser_session_access, args)).ok).toBe(true);

		// Hand the organization to someone else. The user's read permission came from owning it, so
		// they lose access to their own draft while the running session still points at it.
		await t.run(async (ctx) => {
			const ownerUserId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", fixture.organizationId, { ownerUserId });
		});

		// The draft itself did not change. Only the access did, and the check must follow it.
		expect((await t.run((ctx) => ctx.db.get("files_pending_nodes", fixture.nodeId)))?.state).toBe("active");
		expect((await t.query(internal.files_browser.check_browser_session_access, args)).ok).toBe(false);
	});

	test("check denies a session whose node is gone", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		await t.run((ctx) => ctx.db.delete("files_nodes", fixture.nodeId));

		const checked = await t.query(internal.files_browser.check_browser_session_access, {
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
				mode: "file",
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				billedUserId: fixture.userId,
				billing: { state: "pending" },
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

	test.each(["user", "workspace"] as const)("the %s purge deletes download saves with their session", async (scope) => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		const created = await t.mutation(internal.files_browser.create_browser_download_node, {
			...download_node_args(fixture, sessionId),
		});
		if (created._nay) throw new Error(created._nay.message);

		await t.run((ctx) =>
			scope === "user"
				? files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 })
				: files_browser_db_purge_workspace_batch(ctx as never, {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						batchSize: 10,
					}),
		);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.query("files_browser_download_saves").collect())).toEqual([]);
	});
});

function runner_web_session(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		session: {
			mode: "web" as const,
			sessionId: "runner-web-1",
			navGen: 1,
			loadGen: 0,
			controlGen: 1,
			control: "ready" as const,
			agentAccess: true,
			pageNonce: "nonce-1",
			commandCount: 0,
			idleUntil: Date.now() + 300_000,
			totalUntil: Date.now() + 3_600_000,
			...overrides,
		},
	};
}

type WebFixture = {
	userId: Id<"users">;
	membershipId: Id<"organizations_workspaces_users">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
};

async function seed_web_member(
	t: ReturnType<typeof test_convex>,
	plan: "Free" | "Pro" | "Pay As You Go" = "Pay As You Go",
	organizationName = "test-organization",
): Promise<WebFixture> {
	return await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { plan, organizationName }));
}

/**
 * Add a second person to the owner's workspace with one system role and one plan.
 */
async function add_workspace_member(
	t: ReturnType<typeof test_convex>,
	owner: WebFixture,
	args: { role: "member" | "viewer"; plan: "Free" | "Pro" | "Pay As You Go" },
): Promise<WebFixture> {
	return await t.run(async (ctx) => {
		const { userId } = await test_mocks_fill_db_with.membership(ctx, {
			organizationName: "personal",
			workspaceName: "home",
			plan: args.plan,
		});
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId,
			active: true,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId,
			role: args.role,
			now: Date.now(),
		});
		return { userId, membershipId, organizationId: owner.organizationId, workspaceId: owner.workspaceId };
	});
}

async function start_web_session(t: ReturnType<typeof test_convex>, fixture: WebFixture, startUrl: string | null = null) {
	runnerQueue.push(runner_web_session());
	return await authed(t, fixture.userId).action(api.files_browser.start_web_browser, {
		membershipId: fixture.membershipId,
		viewport: { width: 1280, height: 900 },
		startUrl,
	});
}

async function web_starts_today(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	const day = new Date().toISOString().slice(0, 10);
	const dailyUse = await t.run((ctx) =>
		ctx.db
			.query("files_browser_user_daily_use")
			.withIndex("by_user_day", (q) => q.eq("userId", userId).eq("day", day))
			.first(),
	);
	return dailyUse?.webStarts ?? 0;
}

async function consumed_units(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	const snapshot = await t.run((ctx) =>
		ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
	);
	return snapshot?.meter?.consumedUnits ?? 0;
}

describe("start_web_browser", () => {
	test("starts a web session, counts it at commit, and reattaches for free", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture, "example.com");
		if (started._nay) throw new Error(started._nay.message);
		expect(started._yay.session).toMatchObject({ mode: "web", agentAccess: true, control: "ready", loadGen: 0 });
		expect(runnerCalls[0]).toMatchObject({
			route: "open",
			body: { mode: "web", navGen: 1, agentAccess: true, startUrl: "https://example.com/" },
		});
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.session.sessionId))).toMatchObject({
			mode: "web",
			billedUserId: fixture.userId,
			billing: { state: "pending" },
			runnerSessionId: "runner-web-1",
		});
		expect(await web_starts_today(t, fixture.userId)).toBe(1);

		// A repeated start finds the live session and keeps its page: no open, no count.
		runnerQueue.push({ ...runner_web_session(), alive: true, profileStored: false });
		const again = await start_web_session(t, fixture);
		runnerQueue.length = 0;
		expect(again._yay?.session.sessionId).toBe(started._yay.session.sessionId);
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
		expect(await web_starts_today(t, fixture.userId)).toBe(1);
	});

	test("refuses a viewer", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		const viewer = await add_workspace_member(t, owner, { role: "viewer", plan: "Pro" });
		const started = await start_web_session(t, viewer);
		runnerQueue.length = 0;
		expect(started._nay?.message).toBe("Permission denied");
		expect(runnerCalls).toEqual([]);

		// A member of the same workspace has the permission.
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		expect((await start_web_session(t, member))._nay).toBeUndefined();
	});

	test("refuses an anonymous user", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await t
			.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: fixture.userId })
			.action(api.files_browser.start_web_browser, {
				membershipId: fixture.membershipId,
				viewport: { width: 1280, height: 900 },
				startUrl: null,
			});
		expect(started._nay?.message).toBe("Unauthenticated");
		expect(runnerCalls).toEqual([]);
	});

	test.each(["Pay As You Go", "Pro"] as const)("lets %s start both modes", async (plan) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: fixture.userId, plan }));
		expect((await start_saved_session(t, fixture))._nay).toBeUndefined();

		const other = await seed_web_member(t, plan, "other-organization");
		expect((await start_web_session(t, other))._nay).toBeUndefined();
	});

	test("refuses Free with plan_required in both modes", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: fixture.userId, plan: "Free" }));

		const web = await start_web_session(t, fixture);
		expect(web._nay).toMatchObject({ message: "Plan required", data: { code: "plan_required" } });
		const file = await start_saved_session(t, fixture);
		expect(file._nay).toMatchObject({ message: "Plan required", data: { code: "plan_required" } });
		runnerQueue.length = 0;
		expect(runnerCalls).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_browser_sessions").collect())).toEqual([]);

		const available = await authed(t, fixture.userId).query(api.files_browser.web_browser_available, {
			membershipId: fixture.membershipId,
		});
		expect(available).toEqual({ enabled: true, paidPlan: false });
	});

	test("checks the owner's plan in an owner-billed organization", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t, "Free");
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		await t.run((ctx) => ctx.db.patch("organizations", owner.organizationId, { billingMode: "organization_owner" }));

		// The member pays for Pro, but the owner pays here, and the owner is on Free.
		const refused = await start_web_session(t, member);
		runnerQueue.length = 0;
		expect(refused._nay).toMatchObject({ message: "Plan required", data: { code: "plan_required" } });

		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: owner.userId, plan: "Pro" }));
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: member.userId, plan: "Free" }));
		const started = await start_web_session(t, member);
		if (started._nay) throw new Error(started._nay.message);
		const stored = await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.session.sessionId));
		expect(stored?.billedUserId).toBe(owner.userId);
	});

	test("refuses while web mode is off", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const enabled = process.env.AI_CHAT_BROWSER_ENABLED;
		process.env.AI_CHAT_BROWSER_ENABLED = "false";
		try {
			const started = await start_web_session(t, fixture);
			expect(started._nay?.message).toBe("Browser unavailable");
			const available = await authed(t, fixture.userId).query(api.files_browser.web_browser_available, {
				membershipId: fixture.membershipId,
			});
			expect(available).toEqual({ enabled: false, paidPlan: true });
		} finally {
			process.env.AI_CHAT_BROWSER_ENABLED = enabled;
		}
		runnerQueue.length = 0;
		expect(runnerCalls).toEqual([]);
	});

	test("refuses the 51st web start of the day", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		await t.run((ctx) =>
			ctx.db.insert("files_browser_user_daily_use", {
				userId: fixture.userId,
				day: new Date().toISOString().slice(0, 10),
				webStarts: 50,
				updatedAt: Date.now(),
			}),
		);
		const started = await start_web_session(t, fixture);
		expect(started._nay?.message).toBe("Daily limit reached");
		runnerQueue.length = 0;
		expect(runnerCalls).toEqual([]);
		expect(await web_starts_today(t, fixture.userId)).toBe(50);
	});

	test.each([
		{ code: "busy", message: "Browser did not start" },
		{ code: "address_blocked", message: "Address blocked" },
		{ code: "user_limit", message: "You already have 2 browsers open in other workspaces. End one first." },
		{ code: "organization_limit", message: "Your organization already has 4 browsers open. Try again later." },
	])("does not count a failed open ($code)", async ({ code, message }) => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		runnerQueue.push({ ok: false, error: { code, message: "refused" } });
		const started = await authed(t, fixture.userId).action(api.files_browser.start_web_browser, {
			membershipId: fixture.membershipId,
			viewport: { width: 1280, height: 900 },
			startUrl: "https://example.com",
		});
		expect(started._nay?.message).toBe(message);
		expect(await web_starts_today(t, fixture.userId)).toBe(0);
		expect(await t.run((ctx) => ctx.db.query("files_browser_sessions").collect())).toEqual([]);
	});

	test("End during Start still bills the browser time, even when the cron runs first", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const acquiredAt = Date.now() - 20_000;
		const checkDuringOpen = during_next_runner_open(async () => {
			const starting = await t.run((ctx) => ctx.db.query("files_browser_sessions").first());
			if (!starting) throw new Error("Expected a starting doc");
			const ended = await authed(t, fixture.userId).action(api.files_browser.end_browser, {
				membershipId: fixture.membershipId,
				sessionId: starting._id,
			});
			expect(ended._nay).toBeUndefined();

			// The settle cron sees a closed doc with no runner session yet. It must wait for the start
			// action instead of billing 0.
			await t.action(internal.files_browser.settle_pending_browser_usage, {});
			expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", starting._id)))?.billing).toEqual({
				state: "pending",
			});
		}, runner_web_session());
		runnerQueue.push({
			ok: true,
			existed: true,
			verified: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 20_000, reason: "closed" },
		});

		const started = await authed(t, fixture.userId).action(api.files_browser.start_web_browser, {
			membershipId: fixture.membershipId,
			viewport: { width: 1280, height: 900 },
			startUrl: null,
		});
		await checkDuringOpen();
		expect(started._nay?.message).toBe("Browser did not start");
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "close"]);
		const docs = await t.run((ctx) => ctx.db.query("files_browser_sessions").collect());
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({
			control: "closed",
			runnerSessionId: "runner-web-1",
			billing: { state: "settled", billedMs: 20_000, amountCents: 0.3 },
		});
		// The hourly sweep deletes docs by their start deadline, so a billed-later doc must not keep one.
		expect(docs[0]?.startingExpiresAt).toBeUndefined();
	});

	test("refuses a bad start address before the runner", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await authed(t, fixture.userId).action(api.files_browser.start_web_browser, {
			membershipId: fixture.membershipId,
			viewport: { width: 1280, height: 900 },
			startUrl: "javascript:alert(1)",
		});
		expect(started._nay?.message).toBe("Address blocked");
		expect(runnerCalls).toEqual([]);
	});

	test("reports busy both ways with the live mode", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const file = await start_saved_session(t, fixture);
		expect(file._nay).toBeUndefined();

		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
		const web = await start_web_session(t, fixture);
		runnerQueue.length = 0;
		expect(web._nay).toMatchObject({ message: "Browser busy", data: { mode: "file" } });

		runnerQueue.push({ ok: true, existed: true, verified: true, usage: null });
		await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: file._yay!.sessionId,
		});
		expect((await start_web_session(t, fixture))._nay).toBeUndefined();

		runnerQueue.push({ ...runner_web_session(), alive: true, profileStored: false });
		const fileAgain = await start_saved_session(t, fixture, { navigationGeneration: 2 });
		runnerQueue.length = 0;
		expect(fileAgain._nay).toMatchObject({ message: "Browser busy", data: { mode: "web" } });
	});
});

describe("web browser access", () => {
	test("internal close works after the owner's membership is gone", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const started = await start_web_session(t, member);
		if (started._nay) throw new Error(started._nay.message);
		await t.run((ctx) => ctx.db.delete("organizations_workspaces_users", member.membershipId));

		const acquiredAt = Date.now() - 30_000;
		runnerQueue.push({
			ok: true,
			existed: true,
			verified: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 30_000, reason: "access_lost" },
		});
		await t.action(internal.files_browser.end_browser_session_internal, {
			sessionId: started._yay.session.sessionId,
			reason: "access_lost",
		});
		expect(runnerCalls.at(-1)).toMatchObject({ route: "close", body: { saveProfile: false, reason: "access_lost" } });
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.session.sessionId))).toMatchObject({
			control: "closed",
			billing: { state: "settled", billedMs: 30_000, amountCents: 0.3 },
		});
	});

	test("removing a member closes their live browser", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const started = await start_web_session(t, member);
		if (started._nay) throw new Error(started._nay.message);
		// The removal clears the member's API credential counter, which a real invite creates.
		await t.run((ctx) =>
			quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: member.userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				now: Date.now(),
			}),
		);

		const acquiredAt = Date.now() - 30_000;
		// The close and the wipe of the member's saved profile run as separate scheduled jobs, in any
		// order. So both replies fit either route.
		const reply = {
			ok: true,
			existed: true,
			verified: true,
			deleted: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 30_000, reason: "closed" },
		};
		runnerQueue.push(reply, reply);
		vi.useFakeTimers();
		try {
			const removed = await authed(t, owner.userId).mutation(api.organizations.remove_user_from_organization, {
				organizationId: owner.organizationId,
				userIdToRemove: member.userId,
			});
			expect(removed._nay).toBeUndefined();
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		expect(runnerCalls.map((call) => call.route).sort()).toEqual(["close", "open", "profile-delete"]);
		expect(runnerCalls.find((call) => call.route === "close")).toMatchObject({
			body: { saveProfile: false, reason: "member_removed" },
		});
		expect(await t.run((ctx) => ctx.db.query("files_browser_profiles").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_browser_profile_wipes").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.session.sessionId))).toMatchObject({
			control: "closed",
			billing: { state: "settled", billedMs: 30_000, amountCents: 0.3 },
		});
	});

	test("the browser cron closes a live web browser whose owner lost access", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const ownerSession = await start_web_session(t, owner);
		const memberSession = await start_web_session(t, member);
		if (ownerSession._nay || memberSession._nay) throw new Error("Expected two web sessions");

		// The member becomes a viewer, and viewers may not use the browser.
		await t.run(async (ctx) => {
			const assignments = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_user_workspace", (q) =>
					q.eq("organizationId", owner.organizationId).eq("userId", member.userId),
				)
				.collect();
			await Promise.all(
				assignments.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
			);
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: member.userId,
				role: "viewer",
				now: Date.now(),
			});
		});

		runnerQueue.push({ ok: true, existed: true, verified: true, usage: null });
		vi.useFakeTimers();
		try {
			await t.action(internal.files_browser.settle_pending_browser_usage, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "open", "close"]);
		expect(
			(await t.run((ctx) => ctx.db.get("files_browser_sessions", memberSession._yay.session.sessionId)))?.control,
		).toBe("closed");
		expect(
			(await t.run((ctx) => ctx.db.get("files_browser_sessions", ownerSession._yay.session.sessionId)))?.control,
		).toBe("ready");
	});

	test("check_browser_session_access refuses when agent access is off", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const args = { ...fixture, sessionId: started._yay.session.sessionId };
		expect(await t.query(internal.files_browser.check_browser_session_access, args)).toMatchObject({
			ok: true,
			mode: "web",
		});

		runnerQueue.push(runner_web_session({ agentAccess: false, controlGen: 2 }));
		const switched = await authed(t, fixture.userId).action(api.files_browser.set_browser_agent_access, {
			membershipId: fixture.membershipId,
			sessionId: started._yay.session.sessionId,
			on: false,
		});
		expect(switched._yay).toEqual({ agentAccess: false, controlGen: 2 });
		expect(runnerCalls.at(-1)).toMatchObject({ route: "agent-access", body: { on: false } });
		expect(await t.query(internal.files_browser.check_browser_session_access, args)).toEqual({
			ok: false,
			reason: "agent_access_off",
		});
	});

	test("human End saves the profile and the agent close does not", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);

		runnerQueue.push({ ok: true, existed: true, verified: true, usage: null });
		await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay.session.sessionId,
			expectedAgentLease: { controlGen: 1, loadGen: 0, navGen: 1 },
		});
		expect(runnerCalls.at(-1)?.body).toMatchObject({ saveProfile: false, reason: "agent_close" });

		const again = await start_web_session(t, fixture);
		if (again._nay) throw new Error(again._nay.message);
		runnerQueue.push({ ok: true, existed: true, verified: true, usage: null });
		await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId: again._yay.session.sessionId,
		});
		expect(runnerCalls.at(-1)?.body).toMatchObject({ saveProfile: true, reason: "human_end" });
	});
});

describe("browser billing", () => {
	test("settles once, per started minute", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		const before = await consumed_units(t, fixture.userId);

		// 121 seconds is three started minutes. 3 x 0.3 must bill exactly 0.9.
		const acquiredAt = Date.now() - 121_000;
		runnerQueue.push({
			ok: true,
			existed: true,
			verified: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 121_000, reason: "closed" },
		});
		const ended = await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId,
		});
		expect(ended._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			control: "closed",
			billing: { state: "settled", billedMs: 121_000, amountCents: 0.9 },
		});
		expect(await consumed_units(t, fixture.userId)).toBeCloseTo(before + 0.9);

		// A second settle, for example from the cron racing End, changes nothing.
		await t.mutation(internal.files_browser.settle_browser_usage, {
			sessionId,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 600_000, reason: "closed" },
		});
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			billing: { state: "settled", billedMs: 121_000, amountCents: 0.9 },
		});
		expect(await consumed_units(t, fixture.userId)).toBeCloseTo(before + 0.9);
	});

	test("bills the payer frozen at start after an ownership transfer", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t, "Pro");
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Free" });
		await t.run((ctx) => ctx.db.patch("organizations", owner.organizationId, { billingMode: "organization_owner" }));
		const started = await start_web_session(t, member);
		if (started._nay) throw new Error(started._nay.message);

		const nextOwner = await seed_web_member(t, "Pro", "other-organization");
		await t.run((ctx) => ctx.db.patch("organizations", owner.organizationId, { ownerUserId: nextOwner.userId }));
		const ownerBefore = await consumed_units(t, owner.userId);
		const nextOwnerBefore = await consumed_units(t, nextOwner.userId);

		const acquiredAt = Date.now() - 60_000;
		runnerQueue.push({
			ok: true,
			existed: true,
			verified: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 60_000, reason: "closed" },
		});
		await authed(t, member.userId).action(api.files_browser.end_browser, {
			membershipId: member.membershipId,
			sessionId: started._yay.session.sessionId,
		});
		expect(await consumed_units(t, owner.userId)).toBeCloseTo(ownerBefore + 0.3);
		expect(await consumed_units(t, nextOwner.userId)).toBe(nextOwnerBefore);
	});

	test("the cron settles a session whose doc stayed ready", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		// The runner ended the session at its total deadline, but no app door saw it.
		const endedAt = Date.now() - 11 * 60 * 1000;
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", sessionId, { totalUntil: endedAt }));

		runnerQueue.push({
			ok: true,
			alive: false,
			closing: false,
			usage: { providerAcquiredAt: endedAt - 120_000, endedAt, reason: "total_deadline" },
			profileStored: false,
		});
		await t.action(internal.files_browser.settle_pending_browser_usage, {});
		expect(runnerCalls.at(-1)?.route).toBe("status");
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			control: "closed",
			billing: { state: "settled", billedMs: 120_000, amountCents: 0.6 },
		});
	});

	test("does not settle while the runner is still closing", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		await t.run((ctx) =>
			ctx.db.patch("files_browser_sessions", sessionId, { totalUntil: Date.now() - 11 * 60 * 1000 }),
		);

		runnerQueue.push({ ok: true, alive: false, closing: true, usage: null, profileStored: false });
		await t.action(internal.files_browser.settle_pending_browser_usage, {});
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			control: "ready",
			billing: { state: "pending" },
		});

		// A status check from a door leaves the doc alone too.
		runnerQueue.push({ ok: true, alive: false, closing: true, usage: null, profileStored: false });
		const again = await authed(t, fixture.userId).action(api.files_browser.start_web_browser, {
			membershipId: fixture.membershipId,
			viewport: { width: 1280, height: 900 },
			startUrl: null,
		});
		expect(again._nay?.message).toBe("The last browser is still closing. Try again in a minute.");
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.billing.state).toBe("pending");
	});

	test("sends one Polar event for a signed-in payer", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		// A Clerk-backed payer is billed through Polar, not through the local anonymous meter.
		await t.run((ctx) => ctx.db.patch("users", fixture.userId, { clerkUserId: "clerk_browser_payer" }));
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		const before = await consumed_units(t, fixture.userId);
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const polarEvents = () =>
			enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events").map((call) => call[2]);

		const acquiredAt = Date.now() - 61_000;
		const usage = { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 61_000, reason: "closed" };
		runnerQueue.push({ ok: true, existed: true, verified: true, usage });
		await authed(t, fixture.userId).action(api.files_browser.end_browser, {
			membershipId: fixture.membershipId,
			sessionId,
		});

		expect(polarEvents()).toEqual([
			{
				events: [
					{
						name: "browser_usage",
						externalCustomerId: fixture.userId,
						externalMemberId: fixture.userId,
						externalId: expect.stringContaining(sessionId),
						metadata: {
							amount: 0.6,
							actorUserId: fixture.userId,
							billedUserId: fixture.userId,
							organizationId: fixture.organizationId,
							workspaceId: fixture.workspaceId,
							sessionId,
							mode: "web",
							billedMs: 61_000,
						},
					},
				],
			},
		]);
		expect(await consumed_units(t, fixture.userId)).toBe(before);

		// The cron racing End sends no second event.
		await t.mutation(internal.files_browser.settle_browser_usage, { sessionId, usage });
		expect(polarEvents()).toHaveLength(1);
	});

	test("the settle cron moves docs it cannot settle behind newer ones", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const now = Date.now();
		const { goodId } = await t.run(async (ctx) => {
			const session = {
				mode: "web" as const,
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				billedUserId: fixture.userId,
				billing: { state: "pending" as const },
				agentAccess: true,
				navigationGeneration: 1,
				loadGen: 0,
				controlGen: 1,
				control: "closed" as const,
				closedAt: now - 60_000,
				createdAt: now - 60_000,
			};
			// A full batch of old docs the runner still reports as closing.
			for (let index = 0; index < 50; index++) {
				await ctx.db.insert("files_browser_sessions", {
					...session,
					runnerSessionId: `stuck-${index}`,
					updatedAt: now - 60_000 + index,
				});
			}
			const goodId = await ctx.db.insert("files_browser_sessions", {
				...session,
				runnerSessionId: "good",
				updatedAt: now - 1000,
			});
			return { goodId };
		});
		// Answer each status by its session id: stuck docs are still closing, the newer one is gone.
		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { sessionId: string };
			return Response.json(
				body.sessionId === "good"
					? {
							ok: true,
							alive: false,
							closing: false,
							usage: { providerAcquiredAt: now - 90_000, endedAt: now - 60_000, reason: "closed" },
							profileStored: false,
						}
					: { ok: true, alive: false, closing: true, usage: null, profileStored: false },
			);
		});

		// The first run reads the 50 oldest docs only.
		await t.action(internal.files_browser.settle_pending_browser_usage, {});
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", goodId)))?.billing.state).toBe("pending");

		// Those docs moved back, so the next run reaches the newer doc.
		await t.action(internal.files_browser.settle_pending_browser_usage, {});
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", goodId)))?.billing).toMatchObject({
			state: "settled",
			billedMs: 30_000,
		});
	});

	test("bills nothing when the receipt stays missing past the wait", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;

		// Just ended: wait for the receipt, but close the doc.
		await t.mutation(internal.files_browser.settle_browser_usage, { sessionId, usage: null });
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			control: "closed",
			billing: { state: "pending" },
		});

		await t.run((ctx) =>
			ctx.db.patch("files_browser_sessions", sessionId, { closedAt: Date.now() - 11 * 60 * 1000 }),
		);
		await t.mutation(internal.files_browser.settle_browser_usage, { sessionId, usage: null });
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId)))?.billing).toMatchObject({
			state: "settled",
			billedMs: 0,
			amountCents: 0,
		});
	});
});

describe("saved browser profiles", () => {
	function key_base64(profileKey: ArrayBuffer) {
		return btoa(String.fromCharCode(...new Uint8Array(profileKey)));
	}

	async function list_profiles(t: ReturnType<typeof test_convex>) {
		return await t.run((ctx) => ctx.db.query("files_browser_profiles").collect());
	}

	async function list_wipes(t: ReturnType<typeof test_convex>) {
		return await t.run((ctx) => ctx.db.query("files_browser_profile_wipes").collect());
	}

	async function pending_jobs(t: ReturnType<typeof test_convex>, name: string) {
		return await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.state.kind === "pending" && job.name.includes(name),
			),
		);
	}

	async function seed_profile(
		t: ReturnType<typeof test_convex>,
		fixture: WebFixture,
		overrides: { lastUsedAt?: number } = {},
	) {
		return await t.run((ctx) =>
			ctx.db.insert("files_browser_profiles", {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				profileKey: crypto.getRandomValues(new Uint8Array(32)).buffer,
				agentBlockedHosts: [],
				createdAt: Date.now(),
				lastUsedAt: overrides.lastUsedAt ?? Date.now(),
			}),
		);
	}

	const RUNNER_CLOSED = { ok: true, existed: true, verified: true, usage: null };

	test("keeps one profile per user and workspace and sends it to the runner", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);

		const [profile, ...others] = await list_profiles(t);
		expect(others).toEqual([]);
		expect(profile).toMatchObject({
			userId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			agentBlockedHosts: [],
		});
		expect(profile!.profileKey.byteLength).toBe(32);
		expect(runnerCalls[0]).toMatchObject({
			route: "open",
			body: { profileId: profile!._id, profileKey: key_base64(profile!.profileKey), agentBlockedHosts: [] },
		});

		// End the browser, then start again: the same profile comes back, with a newer lastUsedAt.
		runnerQueue.push(RUNNER_CLOSED);
		await t.action(internal.files_browser.end_browser_session_internal, {
			sessionId: started._yay.session.sessionId,
			reason: "test",
		});
		await t.run((ctx) => ctx.db.patch("files_browser_profiles", profile!._id, { lastUsedAt: 1 }));
		expect((await start_web_session(t, fixture))._nay).toBeUndefined();
		const [again, ...othersAgain] = await list_profiles(t);
		expect(othersAgain).toEqual([]);
		expect(again!._id).toBe(profile!._id);
		expect(key_base64(again!.profileKey)).toBe(key_base64(profile!.profileKey));
		expect(again!.lastUsedAt).toBeGreaterThan(1);
		expect(runnerCalls.at(-1)).toMatchObject({
			route: "open",
			body: { profileId: profile!._id, profileKey: key_base64(profile!.profileKey) },
		});

		// Another member of the same workspace gets a profile of their own.
		const member = await add_workspace_member(t, fixture, { role: "member", plan: "Pro" });
		expect((await start_web_session(t, member))._nay).toBeUndefined();
		const profiles = await list_profiles(t);
		expect(profiles.map((doc) => doc.userId).sort()).toEqual([fixture.userId, member.userId].sort());
		expect(new Set(profiles.map((doc) => key_base64(doc.profileKey))).size).toBe(2);
	});

	test("never returns the profile key from a public door", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const asUser = authed(t, fixture.userId);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const [profile] = await list_profiles(t);
		const keyText = key_base64(profile!.profileKey);

		const returned: Array<unknown> = [started];
		returned.push(
			await asUser.mutation(api.files_browser.set_browser_agent_blocked_hosts, {
				membershipId: fixture.membershipId,
				hosts: ["bank.example"],
			}),
		);
		returned.push(
			await asUser.query(api.files_browser.current_browser_profile, { membershipId: fixture.membershipId }),
		);
		returned.push(
			await asUser.query(api.files_browser.current_browser_session, { membershipId: fixture.membershipId }),
		);
		runnerQueue.push(RUNNER_CLOSED, {
			ok: true,
			exists: true,
			savedAt: 123,
			truncated: false,
			sites: [{ domain: "example.com", cookies: 2 }],
		});
		returned.push(
			await asUser.action(api.files_browser.list_browser_profile_sites, { membershipId: fixture.membershipId }),
		);
		runnerQueue.push({ ok: true, removed: 2 });
		returned.push(
			await asUser.action(api.files_browser.clear_browser_profile_site, {
				membershipId: fixture.membershipId,
				domain: "example.com",
			}),
		);
		vi.useFakeTimers();
		try {
			returned.push(
				await asUser.action(api.files_browser.clear_browser_profile, { membershipId: fixture.membershipId }),
			);
		} finally {
			vi.useRealTimers();
		}

		// Write bytes as base64, so a leaked key shows up as its text.
		const text = JSON.stringify(returned, (_key, value: unknown) =>
			value instanceof ArrayBuffer ? key_base64(value) : value,
		);
		expect(text).not.toContain(keyText);
		expect(text).not.toContain("profileKey");
		expect(returned.slice(1, 3)).toEqual([
			{ _yay: null },
			{ exists: true, lastUsedAt: profile!.lastUsedAt, agentBlockedHosts: ["bank.example"] },
		]);
	});

	test("Clear all ends the browser, deletes the profile, and the next start makes a new one", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const asUser = authed(t, fixture.userId);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		await asUser.mutation(api.files_browser.set_browser_agent_blocked_hosts, {
			membershipId: fixture.membershipId,
			hosts: ["bank.example"],
		});
		const [before] = await list_profiles(t);

		runnerQueue.push(RUNNER_CLOSED);
		// Fake timers hold the scheduled wipe job, so the wipe doc stays readable here.
		vi.useFakeTimers();
		try {
			const cleared = await asUser.action(api.files_browser.clear_browser_profile, {
				membershipId: fixture.membershipId,
			});
			expect(cleared).toEqual({ _yay: null });
			expect(await pending_jobs(t, "process_browser_profile_wipes")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}

		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "close"]);
		expect(runnerCalls.at(-1)).toMatchObject({ body: { saveProfile: false, reason: "profile_cleared" } });
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.session.sessionId))).toMatchObject({
			control: "closed",
		});
		expect(await list_profiles(t)).toEqual([]);
		expect(await list_wipes(t)).toEqual([
			expect.objectContaining({
				profileId: before!._id,
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				attempts: 0,
			}),
		]);

		expect((await start_web_session(t, fixture))._nay).toBeUndefined();
		const [after] = await list_profiles(t);
		expect(after!._id).not.toBe(before!._id);
		expect(key_base64(after!.profileKey)).not.toBe(key_base64(before!.profileKey));
		expect(after!.agentBlockedHosts).toEqual([]);
		expect(runnerCalls.at(-1)).toMatchObject({
			route: "open",
			body: { profileId: after!._id, profileKey: key_base64(after!.profileKey), agentBlockedHosts: [] },
		});
	});

	test("Clear all without a profile calls nothing", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const cleared = await authed(t, fixture.userId).action(api.files_browser.clear_browser_profile, {
			membershipId: fixture.membershipId,
		});
		expect(cleared).toEqual({ _yay: null });
		expect(runnerCalls).toEqual([]);
		expect(await list_wipes(t)).toEqual([]);
	});

	test("listing and clearing sites end the live browser first", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const asUser = authed(t, fixture.userId);

		// Without a profile there is nothing to ask the runner.
		expect(
			await asUser.action(api.files_browser.list_browser_profile_sites, { membershipId: fixture.membershipId }),
		).toEqual({ _yay: { exists: false, savedAt: null, truncated: false, sites: [] } });
		expect(
			await asUser.action(api.files_browser.clear_browser_profile_site, {
				membershipId: fixture.membershipId,
				domain: "example.com",
			}),
		).toEqual({ _yay: { removed: 0 } });
		expect(runnerCalls).toEqual([]);

		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const [profile] = await list_profiles(t);
		const sites = [{ domain: "example.com", cookies: 3 }];
		runnerQueue.push(RUNNER_CLOSED, { ok: true, exists: true, savedAt: 123, truncated: false, sites });
		const listed = await asUser.action(api.files_browser.list_browser_profile_sites, {
			membershipId: fixture.membershipId,
		});
		expect(listed).toEqual({ _yay: { exists: true, savedAt: 123, truncated: false, sites } });
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "close", "profile-summary"]);
		expect(runnerCalls.at(-1)?.body).toEqual({
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			profileId: profile!._id,
			profileKey: key_base64(profile!.profileKey),
		});

		const invalid = await asUser.action(api.files_browser.clear_browser_profile_site, {
			membershipId: fixture.membershipId,
			domain: "https://example.com/login",
		});
		expect(invalid._nay?.message).toBe("Invalid site");
		expect(runnerCalls).toHaveLength(3);

		// The browser is already closed, so only the clear call runs.
		runnerQueue.push({ ok: true, removed: 3 });
		const cleared = await asUser.action(api.files_browser.clear_browser_profile_site, {
			membershipId: fixture.membershipId,
			domain: " Example.COM. ",
		});
		expect(cleared).toEqual({ _yay: { removed: 3 } });
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "close", "profile-summary", "profile-clear"]);
		expect(runnerCalls.at(-1)?.body).toMatchObject({ profileId: profile!._id, domain: "example.com" });

		// A runner refusal comes back with its code.
		runnerQueue.push({ ok: false, error: { code: "busy", message: "Browser is busy" } });
		const busy = await asUser.action(api.files_browser.list_browser_profile_sites, {
			membershipId: fixture.membershipId,
		});
		expect(busy._nay).toMatchObject({ message: "Browser is busy", name: "busy" });

		// Stored cookies that do not decrypt get one fixed text, which points to Clear all.
		const unreadable = {
			ok: false,
			error: { code: "profile_unreadable", message: "The saved browser data cannot be read." },
		};
		runnerQueue.push(unreadable, unreadable);
		const refusals = [
			await asUser.action(api.files_browser.list_browser_profile_sites, { membershipId: fixture.membershipId }),
			await asUser.action(api.files_browser.clear_browser_profile_site, {
				membershipId: fixture.membershipId,
				domain: "example.com",
			}),
		];
		for (const refused of refusals) {
			expect(refused._nay).toEqual({
				name: "profile_unreadable",
				message: "Saved data could not be read. Clear all to start fresh.",
			});
		}
	});

	test("set_browser_agent_blocked_hosts stores canonical hosts and checks them", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const asUser = authed(t, fixture.userId);
		const setHosts = (hosts: Array<string>) =>
			asUser.mutation(api.files_browser.set_browser_agent_blocked_hosts, { membershipId: fixture.membershipId, hosts });

		expect(await setHosts([" Bank.Example. ", "bank.example", "bücher.de", "10.0.0.1"])).toEqual({ _yay: null });
		const state = await asUser.query(api.files_browser.current_browser_profile, {
			membershipId: fixture.membershipId,
		});
		expect(state?.agentBlockedHosts).toEqual(["bank.example", "xn--bcher-kva.de", "10.0.0.1"]);

		for (const bad of [
			"",
			"https://bank.example",
			"bank.example/login",
			"bank.example:443",
			"user@bank.example",
			"a b",
			"-bad.example",
			"bank..example",
		]) {
			expect((await setHosts(["ok.example", bad]))._nay?.message, bad).toBe("Invalid site");
		}

		const many = Array.from({ length: 51 }, (_, index) => `site${index}.example`);
		expect((await setHosts(many))._nay?.message).toBe("Too many sites");
		expect(await setHosts(many.slice(0, 50))).toEqual({ _yay: null });
		const [profile] = await list_profiles(t);
		expect(profile!.agentBlockedHosts).toHaveLength(50);

		// The list set before the first start lives in the profile the start then uses.
		expect(await setHosts(["bank.example"])).toEqual({ _yay: null });
		expect((await start_web_session(t, fixture))._nay).toBeUndefined();
		expect(await list_profiles(t)).toHaveLength(1);
		expect(runnerCalls[0]).toMatchObject({
			route: "open",
			body: { profileId: profile!._id, agentBlockedHosts: ["bank.example"] },
		});

		// A viewer may not use the browser, so a viewer may not set its list either.
		const viewer = await add_workspace_member(t, fixture, { role: "viewer", plan: "Pro" });
		const refused = await authed(t, viewer.userId).mutation(api.files_browser.set_browser_agent_blocked_hosts, {
			membershipId: viewer.membershipId,
			hosts: ["bank.example"],
		});
		expect(refused._nay?.message).toBe("Permission denied");
	});

	test("another member cannot read or change the profile", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		expect((await start_web_session(t, owner))._nay).toBeUndefined();
		const [profile] = await list_profiles(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const asMember = authed(t, member.userId);

		expect(
			await asMember.query(api.files_browser.current_browser_profile, { membershipId: owner.membershipId }),
		).toBe(null);
		expect(
			(await asMember.action(api.files_browser.list_browser_profile_sites, { membershipId: owner.membershipId }))._nay
				?.message,
		).toBe("Unauthorized");
		expect(
			(
				await asMember.action(api.files_browser.clear_browser_profile_site, {
					membershipId: owner.membershipId,
					domain: "example.com",
				})
			)._nay?.message,
		).toBe("Unauthorized");
		expect(
			(await asMember.action(api.files_browser.clear_browser_profile, { membershipId: owner.membershipId }))._nay
				?.message,
		).toBe("Unauthorized");
		expect(
			(
				await asMember.mutation(api.files_browser.set_browser_agent_blocked_hosts, {
					membershipId: owner.membershipId,
					hosts: ["bank.example"],
				})
			)._nay?.message,
		).toBe("Unauthorized");

		// The member's own view shows no profile, and the owner's profile is untouched.
		expect(
			await asMember.query(api.files_browser.current_browser_profile, { membershipId: member.membershipId }),
		).toEqual({ exists: false, lastUsedAt: null, agentBlockedHosts: [] });
		expect(await list_profiles(t)).toEqual([profile]);
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});

	test("the wipe job deletes the wipe doc when the runner deleted the bytes", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const profileId = await seed_profile(t, fixture);
		await t.run(async (ctx) => {
			const profile = await ctx.db.get("files_browser_profiles", profileId);
			await files_browser_db_delete_profile(ctx as never, profile!);
		});

		// Wipes reach the runner while web mode is off too.
		runnerQueue.push({ ok: true, deleted: true });
		const enabled = process.env.AI_CHAT_BROWSER_ENABLED;
		process.env.AI_CHAT_BROWSER_ENABLED = "false";
		try {
			await t.action(internal.files_browser.process_browser_profile_wipes, {});
		} finally {
			process.env.AI_CHAT_BROWSER_ENABLED = enabled;
		}
		expect(runnerCalls).toEqual([
			{
				route: "profile-delete",
				body: {
					ownerId: fixture.userId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					profileId,
				},
			},
		]);
		expect(await list_wipes(t)).toEqual([]);
	});

	test("the wipe job backs off after each failure, up to 6 hours", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const start = Date.now();
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			const wipeId = await t.run((ctx) =>
				ctx.db.insert("files_browser_profile_wipes", {
					profileId: "profile-1",
					ownerId: fixture.userId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					createdAt: start,
					attempts: 0,
					nextAttemptAt: start,
				}),
			);
			const failure = { ok: false, error: { code: "error", message: "boom" } };

			runnerQueue.push(failure);
			await t.action(internal.files_browser.process_browser_profile_wipes, {});
			expect(await t.run((ctx) => ctx.db.get("files_browser_profile_wipes", wipeId))).toMatchObject({
				attempts: 1,
				nextAttemptAt: start + 60_000,
			});
			expect(warn).toHaveBeenCalledWith("browser_profile_wipe_failed", { attempts: 1 });

			// Not due yet: no runner call.
			await t.action(internal.files_browser.process_browser_profile_wipes, {});
			expect(runnerCalls).toHaveLength(1);

			vi.setSystemTime(start + 60_000);
			runnerQueue.push(failure);
			await t.action(internal.files_browser.process_browser_profile_wipes, {});
			expect(await t.run((ctx) => ctx.db.get("files_browser_profile_wipes", wipeId))).toMatchObject({
				attempts: 2,
				nextAttemptAt: start + 60_000 + 120_000,
			});

			vi.setSystemTime(start + 60_000 + 120_000);
			runnerQueue.push(failure);
			await t.action(internal.files_browser.process_browser_profile_wipes, {});
			expect(await t.run((ctx) => ctx.db.get("files_browser_profile_wipes", wipeId))).toMatchObject({
				attempts: 3,
				nextAttemptAt: start + 60_000 + 120_000 + 240_000,
			});

			// A reply without `deleted: true` is a failure too. Many failures stop growing at 6 hours.
			await t.run((ctx) =>
				ctx.db.patch("files_browser_profile_wipes", wipeId, { attempts: 20, nextAttemptAt: start }),
			);
			runnerQueue.push({ ok: true });
			await t.action(internal.files_browser.process_browser_profile_wipes, {});
			expect(await t.run((ctx) => ctx.db.get("files_browser_profile_wipes", wipeId))).toMatchObject({
				attempts: 21,
				nextAttemptAt: start + 60_000 + 120_000 + 6 * 60 * 60 * 1000,
			});
			expect(warn).toHaveBeenLastCalledWith("browser_profile_wipe_failed", { attempts: 21 });
		} finally {
			vi.useRealTimers();
		}
	});

	test("the account deletion batch continues until every profile is gone", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		for (let index = 0; index < 51; index++) {
			await seed_profile(t, fixture);
		}
		// Answer every wipe with success, in any order.
		vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true, deleted: true }));

		vi.useFakeTimers();
		try {
			await t.mutation(internal.files_browser.delete_user_profiles_batch, { userId: fixture.userId });
			// One batch deletes 50 docs and writes their 50 wipe docs in the same transaction.
			expect(await list_profiles(t)).toHaveLength(1);
			expect(await list_wipes(t)).toHaveLength(50);
			expect(await pending_jobs(t, "delete_user_profiles_batch")).toHaveLength(1);
			expect(await pending_jobs(t, "process_browser_profile_wipes")).toHaveLength(1);

			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		expect(await list_profiles(t)).toEqual([]);
		expect(await list_wipes(t)).toEqual([]);
	});

	test("the hourly cleanup deletes profiles unused for 90 days", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const day = 24 * 60 * 60 * 1000;
		const oldId = await seed_profile(t, fixture, { lastUsedAt: Date.now() - 91 * day });
		const recentId = await seed_profile(t, fixture, { lastUsedAt: Date.now() - 89 * day });

		vi.useFakeTimers();
		try {
			await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});
			expect(await pending_jobs(t, "process_browser_profile_wipes")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
		expect((await list_profiles(t)).map((doc) => doc._id)).toEqual([recentId]);
		expect((await list_wipes(t)).map((doc) => doc.profileId)).toEqual([oldId]);
	});
});

function runner_download_info(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		name: "Report.PDF",
		size: 4,
		contentType: "application/pdf",
		origin: "https://example.com",
		...overrides,
	};
}

function download_node_args(fixture: WebFixture, sessionId: Id<"files_browser_sessions">, downloadId = "download-1") {
	return {
		userId: fixture.userId,
		membershipId: fixture.membershipId,
		sessionId,
		downloadId,
		name: "data.bin",
		contentType: "application/octet-stream",
		size: 4,
		origin: null,
	};
}

async function save_download(
	t: ReturnType<typeof test_convex>,
	fixture: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
	sessionId: Id<"files_browser_sessions">,
	downloadId = "download-1",
) {
	return await authed(t, fixture.userId).action(api.files_browser.save_browser_download, {
		membershipId: fixture.membershipId,
		sessionId,
		downloadId,
	});
}

async function node_metadata(t: ReturnType<typeof test_convex>, fixture: WebFixture, nodeId: Id<"files_nodes">) {
	const docs = await t.run((ctx) =>
		ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
				q.eq("organizationId", fixture.organizationId).eq("workspaceId", fixture.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect(),
	);
	return Object.fromEntries(docs.filter((doc) => doc.docKind === "value").map((doc) => [doc.fieldPath, doc.stringValue]));
}

async function saved_node_id_by_path(t: ReturnType<typeof test_convex>, fixture: WebFixture, path: string) {
	const node = await t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", fixture.organizationId)
					.eq("workspaceId", fixture.workspaceId)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first(),
	);
	if (!node) throw new Error(`Expected a saved node at ${path}`);
	return node._id;
}

describe("save_browser_download", () => {
	test("saves to /.system/downloads with the origin only, and a second save pushes nothing", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;

		// The runner should send an origin. Convex still keeps only the origin, so a page URL with
		// private values can never reach the metadata of the file.
		runnerQueue.push(runner_download_info({ origin: "https://example.com/account/export?token=secret#top" }), {
			ok: true,
		});
		const saved = await save_download(t, fixture, sessionId);
		if (saved._nay) throw new Error(saved._nay.message);
		expect(saved._yay).toEqual({ nodeId: saved._yay.nodeId, path: "/.system/downloads/report.pdf", shared: true });

		const runnerBody = {
			sessionId: "runner-web-1",
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			downloadId: "download-1",
		};
		const node = await t.run((ctx) => ctx.db.get("files_nodes", saved._yay.nodeId));
		expect(node).toMatchObject({ path: "/.system/downloads/report.pdf", contentType: "application/pdf" });
		const key = r2_create_asset_key({
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			assetId: node!.assetId!,
		});
		expect(runnerCalls.slice(1)).toEqual([
			{ route: "download-info", body: runnerBody },
			{
				route: "download-push",
				body: {
					...runnerBody,
					url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
					headers: { "Content-Type": "application/pdf", "If-None-Match": "*" },
				},
			},
		]);
		expect(await node_metadata(t, fixture, saved._yay.nodeId)).toEqual({
			"metadata.source": "browser-download",
			"metadata.original-url": "https://example.com",
		});

		// A second viewer tab saves the same download. It gets the saved file, and the runner is not asked again.
		runnerQueue.push(runner_download_info(), { ok: true });
		const again = await save_download(t, fixture, sessionId);
		expect(again).toEqual(saved);
		expect(runnerCalls).toHaveLength(3);
		expect(await t.run((ctx) => ctx.db.query("files_browser_download_saves").collect())).toHaveLength(1);
	});

	test("the create step finds the save: it signs the same asset again until the push worked", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const args = download_node_args(fixture, started._yay.session.sessionId);

		const first = await t.mutation(internal.files_browser.create_browser_download_node, args);
		if (first._nay) throw new Error(first._nay.message);
		expect(first._yay).toMatchObject({ kind: "push", path: "/.system/downloads/data.bin", shared: true });
		// A `data:` download has no origin, so no `original-url` is stored.
		expect(await node_metadata(t, fixture, first._yay.nodeId)).toEqual({ "metadata.source": "browser-download" });

		// Two viewer tabs can pass the first check at the same time. The second create finds the save,
		// which is not pushed yet, so it gets an upload URL for the same asset. The runner joins the
		// running push.
		const second = await t.mutation(internal.files_browser.create_browser_download_node, args);
		expect(second).toEqual({ _yay: { ...first._yay } });
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(1);

		await t.mutation(internal.files_browser.mark_browser_download_pushed, {
			sessionId: args.sessionId,
			downloadId: args.downloadId,
		});
		const third = await t.mutation(internal.files_browser.create_browser_download_node, args);
		expect(third).toEqual({
			_yay: { kind: "saved", nodeId: first._yay.nodeId, path: "/.system/downloads/data.bin", shared: true },
		});
	});

	test("a failed push can be retried: the next save pushes the same asset, and then it is saved", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;

		// The runner's PUT to R2 failed. It keeps the bytes for a retry.
		runnerQueue.push(runner_download_info(), {
			ok: false,
			error: { code: "download_push_failed", message: "The download could not be saved." },
		});
		expect(await save_download(t, fixture, sessionId)).toEqual({
			_nay: { name: "download_push_failed", message: "Download not saved: the upload failed." },
		});
		const [save] = await t.run((ctx) => ctx.db.query("files_browser_download_saves").collect());
		expect(save).toMatchObject({ pushedAt: null });

		// Retry. The saved row is not pushed, so the runner is asked to push the same asset again.
		runnerQueue.push(runner_download_info(), { ok: true });
		const retried = await save_download(t, fixture, sessionId);
		if (retried._nay) throw new Error(retried._nay.message);
		expect(retried._yay).toEqual({ nodeId: save!.nodeId, path: "/.system/downloads/report.pdf", shared: true });
		const pushes = runnerCalls.filter((call) => call.route === "download-push");
		expect(pushes).toHaveLength(2);
		expect(pushes[1]!.body.url).toBe(pushes[0]!.body.url);
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_browser_download_saves", save!._id))).toMatchObject({
			pushedAt: expect.any(Number),
		});

		// Now it is saved. A third save asks the runner nothing.
		const callsBefore = runnerCalls.length;
		expect(await save_download(t, fixture, sessionId)).toEqual(retried);
		expect(runnerCalls).toHaveLength(callsBefore);
	});

	test("returns the file another tab saved when the runner already forgot the download", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		const args = { ...download_node_args(fixture, sessionId), name: "report.pdf" };

		// Tab A saves and pushes the download while tab B asks the runner about it. The runner then
		// forgot it, because it forgets a download once it is pushed.
		vi.mocked(fetch).mockImplementationOnce(async () => {
			const created = await t.mutation(internal.files_browser.create_browser_download_node, args);
			if (created._nay) throw new Error(created._nay.message);
			await t.mutation(internal.files_browser.mark_browser_download_pushed, { sessionId, downloadId: "download-1" });
			return Response.json({ ok: false, error: { code: "download_gone", message: "The download is gone." } });
		});
		const saved = await save_download(t, fixture, sessionId);

		expect(saved).toEqual({
			_yay: { nodeId: expect.any(String), path: "/.system/downloads/report.pdf", shared: true },
		});
	});

	test("never replaces a file: a taken name gets -2, and special names get -download", async () => {
		const t = test_convex();
		const fixture = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;

		runnerQueue.push(runner_download_info({ name: "report.pdf" }), { ok: true });
		const first = await save_download(t, fixture, sessionId, "download-1");
		// The personal workspace has no other members, so the file is not shared.
		expect(first._yay).toMatchObject({ path: "/.system/downloads/report.pdf", shared: false });

		runnerQueue.push(runner_download_info({ name: "report.pdf" }), { ok: true });
		const second = await save_download(t, fixture, sessionId, "download-2");
		expect(second._yay).toMatchObject({ path: "/.system/downloads/report-2.pdf", shared: false });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", first._yay!.nodeId))).toMatchObject({
			path: "/.system/downloads/report.pdf",
			archiveOperationId: null,
		});

		// A page must not create an instruction file that the agent would read.
		runnerQueue.push(runner_download_info({ name: "AGENTS.md", contentType: "text/markdown" }), { ok: true });
		const special = await save_download(t, fixture, sessionId, "download-3");
		expect(special._yay).toMatchObject({ path: "/.system/downloads/agents-download.md" });
	});

	test("refuses after the payer's plan drops to Free", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: fixture.userId, plan: "Free" }));

		runnerQueue.push(runner_download_info(), { ok: true });
		expect(await save_download(t, fixture, started._yay.session.sessionId)).toEqual({
			_nay: { message: "Download not saved: your plan no longer allows the browser." },
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "download-info"]);
		expect(await t.run((ctx) => ctx.db.query("files_browser_download_saves").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("refuses a workspace member who does not own the session", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const started = await start_web_session(t, owner);
		if (started._nay) throw new Error(started._nay.message);

		expect(await save_download(t, member, started._yay.session.sessionId)).toEqual({ _nay: { message: "Not found" } });
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});

	test("refuses a file-mode session", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);

		expect(await save_download(t, fixture, started._yay.sessionId)).toEqual({ _nay: { message: "Not found" } });
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});

	test("says so when the runner no longer has the download", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);

		runnerQueue.push({ ok: false, error: { code: "download_gone", message: "Unknown download." } });
		expect(await save_download(t, fixture, started._yay.session.sessionId)).toEqual({
			_nay: { name: "download_gone", message: "Download not saved: it is no longer available." },
		});
	});
});

describe("fill_browser_chooser_from_files", () => {
	async function seed_chooser_files(t: ReturnType<typeof test_convex>) {
		const owner = await seed_web_member(t);
		const first = await test_create_saved_text_file(t, {
			membershipId: owner.membershipId,
			path: "/docs/first.txt",
			textContent: "first",
		});
		const second = await test_create_saved_text_file(t, {
			membershipId: owner.membershipId,
			path: "/docs/second.txt",
			textContent: "second",
		});
		return { owner, first, second };
	}

	async function fill(
		t: ReturnType<typeof test_convex>,
		fixture: WebFixture,
		sessionId: Id<"files_browser_sessions">,
		nodeIds: Array<Id<"files_nodes">>,
	) {
		return await authed(t, fixture.userId).action(api.files_browser.fill_browser_chooser_from_files, {
			membershipId: fixture.membershipId,
			sessionId,
			chooserId: "chooser-1",
			controlGen: 2,
			nodeIds,
		});
	}

	test("gives the runner short signed URLs for readable files", async () => {
		const t = test_convex();
		const { owner, first, second } = await seed_chooser_files(t);
		const started = await start_web_session(t, owner);
		if (started._nay) throw new Error(started._nay.message);

		// Spying again returns the spy from `beforeEach`, with its mock URL.
		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		const timeout = vi.spyOn(AbortSignal, "timeout");
		runnerQueue.push({ ok: true });
		expect(await fill(t, owner, started._yay.session.sessionId, [first, second])).toEqual({ _yay: null });
		// The runner gives the whole fill 120 seconds. Convex waits a bit longer for its answer.
		expect(timeout).toHaveBeenLastCalledWith(150_000);

		const nodes = await t.run(async (ctx) => [
			await ctx.db.get("files_nodes", first),
			await ctx.db.get("files_nodes", second),
		]);
		expect(runnerCalls.at(-1)).toEqual({
			route: "upload-fill",
			body: {
				sessionId: "runner-web-1",
				ownerId: owner.userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				chooserId: "chooser-1",
				controlGen: 2,
				files: nodes.map((node) => ({
					name: node!.name,
					contentType: node!.contentType,
					url: expect.stringMatching(/^https:\/\/r2\.test\/object\?key=/u),
				})),
			},
		});
		// The runner may take up to 120 seconds for the whole fill, so the URLs outlive that.
		expect(getUrl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expiresIn: 300 }));
	});

	test("refuses the whole call when one file is not readable", async () => {
		const t = test_convex();
		const { owner, first, second } = await seed_chooser_files(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const restricted = await authed(t, owner.userId).mutation(api.files_sharing.restrict_node, {
			membershipId: owner.membershipId,
			nodeId: second,
		});
		expect(restricted._nay).toBeUndefined();
		const started = await start_web_session(t, member);
		if (started._nay) throw new Error(started._nay.message);

		runnerQueue.push({ ok: true });
		expect(await fill(t, member, started._yay.session.sessionId, [first, second])).toEqual({
			_nay: { message: "Not found" },
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});

	test("refuses a folder, a total over 20 MiB, and a wrong file count", async () => {
		const t = test_convex();
		const { owner, first } = await seed_chooser_files(t);
		const started = await start_web_session(t, owner);
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;

		const folderId = await saved_node_id_by_path(t, owner, "/docs");
		expect(await fill(t, owner, sessionId, [folderId])).toEqual({ _nay: { message: "Not found" } });

		expect(await fill(t, owner, sessionId, [])).toEqual({ _nay: { message: "Choose 1 to 10 files." } });
		expect(await fill(t, owner, sessionId, Array.from({ length: 11 }, () => first))).toEqual({
			_nay: { message: "Choose 1 to 10 files." },
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", first);
			await ctx.db.patch("files_r2_assets", node!.assetId!, { size: 20 * 1024 * 1024 + 1 });
		});
		expect(await fill(t, owner, sessionId, [first])).toEqual({
			_nay: { message: "Files too large: a page takes at most 20 MB at once." },
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});
});

describe("grant_browser_upload", () => {
	test("returns the runner upload URL with the single-use grant", async () => {
		const t = test_convex();
		const fixture = await seed_web_member(t);
		const started = await start_web_session(t, fixture);
		if (started._nay) throw new Error(started._nay.message);

		const expiresAt = Date.now() + 120_000;
		runnerQueue.push({ ok: true, grantId: "grant-1", expiresAt });
		const granted = await authed(t, fixture.userId).action(api.files_browser.grant_browser_upload, {
			membershipId: fixture.membershipId,
			sessionId: started._yay.session.sessionId,
			chooserId: "chooser-1",
			controlGen: 2,
		});
		const query = new URLSearchParams({
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			grantId: "grant-1",
		});
		expect(granted).toEqual({
			_yay: { url: `https://browser-runner.test/viewer/upload?${query.toString()}`, expiresAt },
		});
		expect(runnerCalls.at(-1)).toEqual({
			route: "upload-grant",
			body: {
				sessionId: "runner-web-1",
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				chooserId: "chooser-1",
				controlGen: 2,
			},
		});
	});

	test("refuses a workspace member who does not own the session", async () => {
		const t = test_convex();
		const owner = await seed_web_member(t);
		const member = await add_workspace_member(t, owner, { role: "member", plan: "Pro" });
		const started = await start_web_session(t, owner);
		if (started._nay) throw new Error(started._nay.message);

		const granted = await authed(t, member.userId).action(api.files_browser.grant_browser_upload, {
			membershipId: member.membershipId,
			sessionId: started._yay.session.sessionId,
			chooserId: "chooser-1",
			controlGen: 2,
		});
		expect(granted).toEqual({ _nay: { message: "Not found" } });
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});
});
