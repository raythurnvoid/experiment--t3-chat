/// <reference types="vite/client" />
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { streamText } from "ai";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import { files_browser_db_delete_user_batch } from "./files_browser.ts";
import { r2_db_finalize_browser_result_asset } from "./r2_client.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import type { Id } from "./_generated/dataModel.js";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";

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
		expect(reloaded._yay).toEqual({ loadGen: 7, sourceVersion: "loaded-7", sourceHash: "hash-7" });
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay!.sessionId))).toMatchObject(
			reloaded._yay!,
		);
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

	test("refreshes a new lease and leaves a started turn frozen", async () => {
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
			expect(await call.prepareStep!(step)).toBeUndefined();
		});
		await t.mutation(internal.files_browser.set_browser_control, { sessionId, control: "ready", controlGen: 4 });
		await t.run(async () => {
			const next = await call.prepareStep!({ ...step, stepNumber: 1 });
			expect(next?.activeTools).toEqual([]);
			expect(next?.system).toContain("since this request started");
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
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

describe("browser results", () => {
	async function seed_thread(t: ReturnType<typeof test_convex>, fixture: BrowserFixture) {
		return await t.run((ctx) =>
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
	}

	async function store_result(
		t: ReturnType<typeof test_convex>,
		fixture: BrowserFixture,
		threadId: Id<"ai_chat_threads">,
	) {
		const textAssetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: fixture.userId,
		});
		const imageAssetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 200,
			createdBy: fixture.userId,
		});
		const sessionId = await t.run((ctx) =>
			ctx.db.insert("files_browser_sessions", {
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				targetKind: "saved",
				nodeId: fixture.nodeId,
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
		return await t.mutation(internal.files_browser.store_browser_result, {
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			threadId,
			sessionId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			runId: "run-1",
			toolCallId: "call-1",
			commandId: "cmd-1",
			textAssetId,
			images: [{ assetId: imageAssetId, mime: "image/png", width: 1280, height: 900 }],
			textBytes: 100,
			imageBytes: 200,
		});
	}

	test("stores and reads a result with signed image urls", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const threadId = await seed_thread(t, fixture);
		const resultId = await store_result(t, fixture, threadId);

		const textKey = r2_create_asset_key({
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			assetId: (await t.run((ctx) => ctx.db.get("ai_chat_browser_results", resultId)))!.textAssetId,
		});
		r2Objects.set(textKey, new TextEncoder().encode(JSON.stringify({ reviewed: true })));

		const asUser = authed(t, fixture.userId);
		const read = await asUser.action(api.files_browser.read_browser_result, {
			membershipId: fixture.membershipId,
			resultId,
		});
		expect(read._nay).toBeUndefined();
		expect(read._yay?.text).toBe(JSON.stringify({ reviewed: true }));
		expect(read._yay?.images.length).toBe(1);
		expect(read._yay?.images[0]).toMatchObject({ mime: "image/png", width: 1280, height: 900 });
		expect(typeof read._yay?.images[0]?.url).toBe("string");
	});

	test("refuses another member and expired results", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const threadId = await seed_thread(t, fixture);
		const resultId = await store_result(t, fixture, threadId);

		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other-ws" }),
		);
		const asOther = authed(t, other.userId);
		const foreign = await asOther.action(api.files_browser.read_browser_result, {
			membershipId: other.membershipId,
			resultId,
		});
		expect(foreign._nay?.message).toBe("Not found");

		await t.run((ctx) => ctx.db.patch("ai_chat_browser_results", resultId, { expiresAt: Date.now() - 1 }));
		const asUser = authed(t, fixture.userId);
		const expired = await asUser.action(api.files_browser.read_browser_result, {
			membershipId: fixture.membershipId,
			resultId,
		});
		expect(expired._nay?.message).toBe("Not found");
		expect(r2FetchCount).toBe(0);
	});

	test("links live results to their file and flags expired ones", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const threadId = await seed_thread(t, fixture);
		const resultId = await store_result(t, fixture, threadId);

		const asUser = authed(t, fixture.userId);
		const live = await asUser.query(api.files_browser.browser_result_file, {
			membershipId: fixture.membershipId,
			resultId,
		});
		expect(live).toEqual({ nodeId: fixture.nodeId, targetKind: "saved", expired: false });

		await t.run((ctx) => ctx.db.patch("ai_chat_browser_results", resultId, { expiresAt: Date.now() - 1 }));
		const expired = await asUser.query(api.files_browser.browser_result_file, {
			membershipId: fixture.membershipId,
			resultId,
		});
		expect(expired).toEqual({ nodeId: fixture.nodeId, targetKind: "saved", expired: true });

		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other-ws" }),
		);
		const foreign = await authed(t, other.userId).query(api.files_browser.browser_result_file, {
			membershipId: other.membershipId,
			resultId,
		});
		expect(foreign).toBe(null);
	});

	test("lists a thread's live results newest first", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const threadId = await seed_thread(t, fixture);
		const first = await store_result(t, fixture, threadId);
		await t.run((ctx) => ctx.db.patch("ai_chat_browser_results", first, { createdAt: Date.now() - 1000 }));
		const second = await store_result(t, fixture, threadId);
		await t.run((ctx) => ctx.db.patch("ai_chat_browser_results", first, { expiresAt: Date.now() - 1 }));

		const asUser = authed(t, fixture.userId);
		const listed = await asUser.query(api.files_browser.list_browser_results, {
			membershipId: fixture.membershipId,
			threadId,
		});
		expect(listed.map((entry) => entry.resultId)).toEqual([second]);
		expect(listed[0]).toMatchObject({ sourceKind: "saved", loadGen: 1, imageCount: 1 });

		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other-ws" }),
		);
		const foreign = await authed(t, other.userId).query(api.files_browser.list_browser_results, {
			membershipId: other.membershipId,
			threadId,
		});
		expect(foreign).toEqual([]);
	});

	test("result list shows own entries past foreign ones", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session(t, fixture);
		const sessionId = started._yay!.sessionId;
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
		const other = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const textAssetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: fixture.userId,
		});
		const base = {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			threadId,
			sessionId,
			targetKind: "saved",
			nodeId: String(fixture.nodeId),
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			textAssetId,
		} as const;
		for (let n = 0; n < 20; n++) {
			await t.run((ctx) =>
				ctx.db.insert("ai_chat_browser_results", {
					...base,
					ownerId: other,
					runId: `run-foreign-${n}`,
					toolCallId: `call-foreign-${n}`,
					commandId: `cmd-foreign-${n}`,
					textAssetId,
					images: [],
					textBytes: 10,
					imageBytes: 0,
					createdAt: Date.now(),
					expiresAt: Date.now() + 3_600_000,
				}),
			);
		}
		const ownId = await t.run((ctx) =>
			ctx.db.insert("ai_chat_browser_results", {
				...base,
				ownerId: fixture.userId,
				runId: "run-own",
				toolCallId: "call-own",
				commandId: "cmd-own",
				textAssetId,
				images: [],
				textBytes: 10,
				imageBytes: 0,
				createdAt: Date.now(),
				expiresAt: Date.now() + 3_600_000,
			}),
		);

		const asUser = authed(t, fixture.userId);
		const listed = await asUser.query(api.files_browser.list_browser_results, {
			membershipId: fixture.membershipId,
			threadId,
		});
		expect(listed.map((entry) => String(entry.resultId))).toEqual([String(ownId)]);
	});
});

describe("cleanup_expired_browser_docs", () => {
	test.each(["starting", "closing", "closed"] as const)("reaches an expired %s start behind a full batch of retained sessions", async (control) => {
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
	});

	test("deletes expired results with deletion jobs and keeps live ones", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
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
		const textAssetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: fixture.userId,
		});
		const sessionId = await t.run((ctx) =>
			ctx.db.insert("files_browser_sessions", {
				ownerId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				targetKind: "saved",
				nodeId: fixture.nodeId,
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
		const liveId = await t.mutation(internal.files_browser.store_browser_result, {
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			threadId,
			sessionId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			runId: "run-1",
			toolCallId: "call-1",
			commandId: "cmd-1",
			textAssetId,
			images: [],
			textBytes: 100,
			imageBytes: 0,
		});
		await t.run((ctx) => ctx.db.patch("ai_chat_browser_results", liveId, { expiresAt: Date.now() - 1 }));

		await t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});
		expect(await t.run((ctx) => ctx.db.get("ai_chat_browser_results", liveId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", textAssetId))).toBe(null);
		const jobs = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.length).toBe(1);
		expect(jobs[0]?.reason).toBe("browser_result_cleanup");
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

	test("result list hides entries whose file access is gone", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
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
		const textAssetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: fixture.userId,
		});
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
		await t.mutation(internal.files_browser.store_browser_result, {
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			threadId,
			sessionId,
			targetKind: "saved",
			nodeId: String(fixture.nodeId),
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			runId: "run-1",
			toolCallId: "call-1",
			commandId: "cmd-1",
			textAssetId,
			images: [],
			textBytes: 100,
			imageBytes: 0,
		});

		const asUser = authed(t, fixture.userId);
		const before = await asUser.query(api.files_browser.list_browser_results, {
			membershipId: fixture.membershipId,
			threadId,
		});
		expect(before.length).toBe(1);

		await t.run((ctx) => ctx.db.delete("files_nodes", fixture.nodeId));
		const after = await asUser.query(api.files_browser.list_browser_results, {
			membershipId: fixture.membershipId,
			threadId,
		});
		expect(after).toEqual([]);
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
	test("user delete batch removes results and enqueues R2 cleanup", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
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
		const textAssetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: fixture.userId,
		});
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
		const resultId = await t.mutation(internal.files_browser.store_browser_result, {
			ownerId: fixture.userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			threadId,
			sessionId,
			targetKind: "saved",
			nodeId: String(fixture.nodeId),
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			runId: "run-1",
			toolCallId: "call-1",
			commandId: "cmd-1",
			textAssetId,
			images: [],
			textBytes: 100,
			imageBytes: 0,
		});

		const first = await t.run((ctx) =>
			files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 }),
		);
		expect(first.deletedCount).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("ai_chat_browser_results", resultId))).toBe(null);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", textAssetId))).toBe(null);
		const jobs = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.length).toBe(1);
		expect(jobs[0]?.reason).toBe("browser_result_cleanup");

		const second = await t.run((ctx) =>
			files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 }),
		);
		expect(second.deletedCount).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toBe(null);

		const drained = await t.run((ctx) =>
			files_browser_db_delete_user_batch(ctx as never, { userId: fixture.userId, batchSize: 10 }),
		);
		expect(drained).toEqual({ done: true, deletedCount: 0 });
	});
});

describe("r2_db_finalize_browser_result_asset", () => {
	test("finalize ignores bad ids, kinds, and workspaces", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const assetId = await t.mutation(internal.r2.insert_asset, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: fixture.userId,
		});

		await t.run((ctx) =>
			r2_db_finalize_browser_result_asset(ctx as never, {
				organizationId: String(fixture.organizationId),
				workspaceId: String(fixture.workspaceId),
				assetId: "not-an-id",
			}),
		);
		await t.run((ctx) =>
			r2_db_finalize_browser_result_asset(ctx as never, {
				organizationId: String(fixture.organizationId),
				workspaceId: String(fixture.workspaceId),
				assetId: String(assetId),
			}),
		);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assetId))).toMatchObject({
			r2Key: expect.any(String),
		});

		const foreign = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other-ws" }),
		);
		const foreignId = await t.mutation(internal.r2.insert_asset, {
			organizationId: foreign.organizationId,
			workspaceId: foreign.workspaceId,
			kind: "browser_result",
			size: 100,
			createdBy: foreign.userId,
		});
		await t.run((ctx) =>
			r2_db_finalize_browser_result_asset(ctx as never, {
				organizationId: String(fixture.organizationId),
				workspaceId: String(fixture.workspaceId),
				assetId: String(foreignId),
			}),
		);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", foreignId))).toMatchObject({
			unfinalizedExpiresAt: expect.any(Number),
		});
		expect((await t.run((ctx) => ctx.db.get("files_r2_assets", foreignId)))?.r2Key).toBeUndefined();
	});
});
