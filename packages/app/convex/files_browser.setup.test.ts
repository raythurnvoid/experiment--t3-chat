// Fixtures shared by the files_browser test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { ai_chat_runs_db_insert_node } from "./ai_chat_runs.ts";

export const runnerQueue: Array<unknown> = [];
export const runnerCalls: Array<{ route: string; body: Record<string, unknown> }> = [];
export const r2Objects = new Map<string, Uint8Array>();
let r2FetchCount = 0;

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

// Importing this file adds these hooks to every test of the importing file.
beforeEach(() => {
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

export const HTML_TEXT = "<!doctype html>\n<html><head><title>T</title></head><body><p>Hi</p></body></html>\n";

export type BrowserFixture = {
	membershipId: Id<"organizations_workspaces_users">;
	userId: Id<"users">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
	path: string;
};

export async function seed_html_file(t: ReturnType<typeof test_convex>, path = "/page.html"): Promise<BrowserFixture> {
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path,
		textContent: HTML_TEXT,
	});
	return { ...db, nodeId, path };
}

export async function seed_private_html_file(t: ReturnType<typeof test_convex>, path = "/draft.html") {
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

export function authed(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	return t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
}

export async function seed_browser_chat_source(t: ReturnType<typeof test_convex>, fixture: WebFixture) {
	const asUser = authed(t, fixture.userId);
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: fixture.membershipId,
		clientGeneratedId: "browser-control-chat",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const sourceMessageId = await t.run(async (ctx) =>
		ai_chat_runs_db_insert_node(ctx, {
			thread: (await ctx.db.get("ai_chat_threads", thread._yay.threadId))!,
			parentId: null,
			createdBy: fixture.userId,
			clientGeneratedMessageId: "browser-control-request",
			content: { role: "user", parts: [{ type: "text", text: "Open the browser." }] },
			status: "done",
			runId: null,
			wakePending: false,
			jobFinishInvocationId: null,
			newest: "set",
			now: Date.now(),
		}),
	);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: fixture.userId,
		membershipId: fixture.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	return {
		...fixture,
		threadId: thread._yay.threadId,
		sourceMessageId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
}

export function runner_open_session(overrides: Record<string, unknown> = {}) {
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
export function during_next_runner_open(during: () => Promise<void>, reply: unknown) {
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

export async function start_saved_session(args: {
	t: ReturnType<typeof test_convex>;
	fixture: BrowserFixture;
	overrides?: Record<string, unknown>;
}) {
	const { t, fixture, overrides = {} } = args;

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

export async function sha256_hex(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Open a browser session on an HTML file. File outputs need the session's current lease and
 * source values, so return those together with the scope and a chat thread.
 */
export async function seed_browser_file_scope(t: ReturnType<typeof test_convex>) {
	const fixture = await seed_html_file(t);
	const started = await start_saved_session({ t, fixture });
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
			newestNodeId: null,
			starred: false,
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

export const browserFile = {
	requestId: "file-output-1",
	attemptId: "attempt-1",
	path: "/reports/capture.bin",
	size: 8,
	contentType: "application/octet-stream",
	digest: "a".repeat(64),
	content: { kind: "stored" as const },
};

export async function prepare_browser_file(args: {
	t: ReturnType<typeof test_convex>;
	scope: Awaited<ReturnType<typeof seed_browser_file_scope>>;
	changes?: Partial<typeof browserFile>;
}) {
	const { t, scope, changes = {} } = args;

	const prepared = await t.mutation(internal.files_browser.prepare_file_output, {
		...scope,
		...browserFile,
		...changes,
	});
	if (prepared._nay) throw new Error(prepared._nay.message);
	if (prepared._yay.kind !== "stored") throw new Error("Expected stored file preparation");
	return prepared._yay;
}

export function runner_web_session(overrides: Record<string, unknown> = {}) {
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
			tabId: "tab-1",
			tabGen: 1,
			viewedTabId: "tab-1",
			viewGen: 1,
			tabCount: 1,
			policyRevision: 0,
			pageNonce: "nonce-1",
			commandCount: 0,
			idleUntil: Date.now() + 300_000,
			totalUntil: Date.now() + 3_600_000,
			...overrides,
		},
	};
}

export type WebFixture = {
	userId: Id<"users">;
	membershipId: Id<"organizations_workspaces_users">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
};

export async function seed_web_member(args: {
	t: ReturnType<typeof test_convex>;
	plan?: "Free" | "Pro" | "Pay As You Go";
	organizationName?: string;
}): Promise<WebFixture> {
	const { t, plan = "Pay As You Go", organizationName = "test-organization" } = args;

	return await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { plan, organizationName }));
}

/**
 * Add a second person to the owner's workspace with one system role and one plan.
 */
export async function add_workspace_member(args: {
	t: ReturnType<typeof test_convex>;
	owner: WebFixture;
	role: "member" | "viewer";
	plan: "Free" | "Pro" | "Pay As You Go";
}): Promise<WebFixture> {
	const { t, owner } = args;

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
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
			displayName: "",
			sortDisplayName: "",
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

export async function start_web_session(args: {
	t: ReturnType<typeof test_convex>;
	fixture: WebFixture;
	startUrl?: string | null;
}) {
	const { t, fixture, startUrl = null } = args;

	const preference = await authed(t, fixture.userId).query(api.files_browser.current_browser_preferences, {
		membershipId: fixture.membershipId,
	});
	runnerQueue.push(
		runner_web_session({
			policyRevision: preference?.policyRevision ?? 0,
			agentAccess: preference?.webAgentAccess !== false,
		}),
	);
	return await authed(t, fixture.userId).action(api.files_browser.start_web_browser, {
		membershipId: fixture.membershipId,
		viewport: { width: 1280, height: 900 },
		startUrl,
	});
}

export async function web_starts_today(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	const day = new Date().toISOString().slice(0, 10);
	const dailyUse = await t.run((ctx) =>
		ctx.db
			.query("files_browser_user_daily_use")
			.withIndex("by_user_day", (q) => q.eq("userId", userId).eq("day", day))
			.first(),
	);
	return dailyUse?.webStarts ?? 0;
}

export async function consumed_units(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	const snapshot = await t.run((ctx) =>
		ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
	);
	return snapshot?.meter?.consumedUnits ?? 0;
}

export function runner_download_info(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		name: "Report.PDF",
		size: 4,
		contentType: "application/pdf",
		origin: "https://example.com",
		...overrides,
	};
}

export function download_node_args(args: {
	fixture: WebFixture;
	sessionId: Id<"files_browser_sessions">;
	downloadId?: string;
}) {
	const { fixture, downloadId = "download-1", sessionId } = args;

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

export async function save_download(args: {
	t: ReturnType<typeof test_convex>;
	fixture: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> };
	sessionId: Id<"files_browser_sessions">;
	downloadId?: string;
}) {
	const { t, fixture, downloadId = "download-1", sessionId } = args;

	return await authed(t, fixture.userId).action(api.files_browser.save_browser_download, {
		membershipId: fixture.membershipId,
		sessionId,
		downloadId,
	});
}

export async function node_metadata(args: {
	t: ReturnType<typeof test_convex>;
	fixture: WebFixture;
	nodeId: Id<"files_nodes">;
}) {
	const { t, fixture, nodeId } = args;

	const docs = await t.run((ctx) =>
		ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
				q.eq("organizationId", fixture.organizationId).eq("workspaceId", fixture.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect(),
	);
	return Object.fromEntries(
		docs.filter((doc) => doc.docKind === "value").map((doc) => [doc.fieldPath, doc.stringValue]),
	);
}

export async function saved_node_id_by_path(args: {
	t: ReturnType<typeof test_convex>;
	fixture: WebFixture;
	path: string;
}) {
	const { t, fixture, path } = args;

	const node = await t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", fixture.organizationId)
					.eq("workspaceId", fixture.workspaceId).eq("moveCohortId", undefined)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first(),
	);
	if (!node) throw new Error(`Expected a saved node at ${path}`);
	return node._id;
}
