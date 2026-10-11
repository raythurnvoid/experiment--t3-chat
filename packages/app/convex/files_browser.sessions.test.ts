/// <reference types="vite/client" />
// Browser start, control, reload and sync tests. File output tests are in files_browser.outputs.test.ts,
// and the rest in files_browser.test.ts.
import { getFunctionName } from "convex/server";
import { createCommandContext, InMemoryFs } from "just-bash/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_create_saved_text_file } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { bash_browser_command_create, type bash_BrowserContext } from "../server/bash-browser-command.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	runnerQueue,
	runnerCalls,
	HTML_TEXT,
	seed_html_file,
	authed,
	seed_browser_chat_source,
	runner_open_session,
	during_next_runner_open,
	start_saved_session,
	runner_web_session,
	seed_web_member,
	start_web_session,
} from "./files_browser.setup.test.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
// Pause real action calls so the race tests can use public human controls.
const browserActionGate = vi.hoisted(() => ({
	call: null as
		| null
		| ((
				args: {
					operation: "query" | "mutation";
					name: string;
					phase: "before" | "after";
				} & Record<string, unknown>,
		  ) => Promise<void>),
}));
vi.mock("./_generated/server.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./_generated/server.js")>();
	return {
		...original,
		internalAction: ((definition: Parameters<typeof original.internalAction>[0]) => {
			if (typeof definition === "function") return original.internalAction(definition);
			return original.internalAction({
				...definition,
				handler: async (ctx, ...args) => {
					const runQuery = ctx.runQuery.bind(ctx);
					const runMutation = ctx.runMutation.bind(ctx);
					ctx.runQuery = async (ref, callArgs) => {
						await browserActionGate.call?.({
							operation: "query",
							name: getFunctionName(ref),
							phase: "before",
							...(callArgs as Record<string, unknown>),
						});
						const result = await runQuery(ref, callArgs);
						await browserActionGate.call?.({
							operation: "query",
							name: getFunctionName(ref),
							phase: "after",
							...(callArgs as Record<string, unknown>),
						});
						return result;
					};
					ctx.runMutation = async (ref, callArgs) => {
						const result = await runMutation(ref, callArgs);
						await browserActionGate.call?.({
							operation: "mutation",
							name: getFunctionName(ref),
							phase: "after",
							...(callArgs as Record<string, unknown>),
						});
						return result;
					};
					return definition.handler(ctx, ...args);
				},
			});
		}) as typeof original.internalAction,
	};
});
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: model.streamText,
}));

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
});

afterEach(() => {
	browserActionGate.call = null;
});

describe("start_browser", () => {
	test.each(["/page.html", "/other.html"])("replaces an expired runner before starting %s", async (path) => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session({ t, fixture });
		const nodeId =
			path === fixture.path
				? fixture.nodeId
				: await test_create_saved_text_file(t, {
						membershipId: fixture.membershipId,
						path,
						textContent: HTML_TEXT,
					});
		runnerQueue.push({ ok: true, alive: false, closing: false, usage: null, profileStored: false });
		const next = await start_saved_session({ t, fixture: { ...fixture, nodeId, path } });
		expect(next._nay).toBeUndefined();
		expect(next._yay?.sessionId).not.toBe(first._yay?.sessionId);
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", first._yay!.sessionId)))?.control).toBe("closed");
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status", "open"]);
	});

	// Start never reads `idleUntil`, so this is also the plain reattach of the same live file.
	test("keeps a live runner when only the mirrored idle deadline is old", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session({ t, fixture });
		await t.run((ctx) => ctx.db.patch("files_browser_sessions", first._yay!.sessionId, { idleUntil: Date.now() - 1 }));
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
		const next = await start_saved_session({ t, fixture });
		expect(next._yay?.sessionId).toBe(first._yay?.sessionId);
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status"]);
	});

	test("preserves the slot when a status request cannot reach the runner", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session({ t, fixture });
		vi.mocked(fetch).mockRejectedValueOnce(new Error("network unavailable"));
		const next = await start_saved_session({ t, fixture });
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

	test("bills the runner time when End runs during Start", async () => {
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
		expect(started._nay?.message).toBe("Browser did not start");
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
		const result = await start_saved_session({ t, fixture });
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
		await start_saved_session({ t, fixture });

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

	// The browser of a file keeps running while the user is on another file. When its file is
	// archived meanwhile, the Files panel hides it, so the next start must close it.
	test("closes a live browser whose file was archived, then starts another file", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const first = await start_saved_session({ t, fixture });
		await t.run((ctx) => ctx.db.patch("files_nodes", fixture.nodeId, { archiveOperationId: "archived" }));
		const otherId = await test_create_saved_text_file(t, {
			membershipId: fixture.membershipId,
			path: "/other.html",
			textContent: HTML_TEXT,
		});

		const acquiredAt = Date.now() - 60_000;
		runnerQueue.push({ ...runner_open_session({ nodeId: fixture.nodeId }), alive: true, profileStored: false });
		runnerQueue.push({
			ok: true,
			existed: true,
			verified: true,
			usage: { providerAcquiredAt: acquiredAt, endedAt: acquiredAt + 60_000, reason: "closed" },
		});
		const next = await start_saved_session({ t, fixture: { ...fixture, nodeId: otherId, path: "/other.html" } });
		expect(next._nay).toBeUndefined();
		expect(next._yay?.nodeId).toBe(String(otherId));
		expect(runnerCalls.map((call) => call.route)).toEqual(["open", "status", "close", "open"]);
		expect(runnerCalls[2]?.body).toMatchObject({ sessionId: "runner-session-1", reason: "access_lost" });
		expect((await t.run((ctx) => ctx.db.get("files_browser_sessions", first._yay!.sessionId)))?.control).toBe("closed");
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
		await start_saved_session({ t, fixture });

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
		expect(started._nay).toMatchObject({ name: "needs_capture", message: "Capture the current editor draft first." });
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
			const started = await start_saved_session({ t, fixture });
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
		const started = await start_saved_session({ t, fixture });
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
	test("returns the exact settled web tab lease", async () => {
		const t = test_convex();
		const fixture = await seed_web_member({ t });
		const started = await start_web_session({ t, fixture });
		if (started._nay) throw new Error(started._nay.message);
		const expectedAgentLease = {
			controlGen: 1,
			loadGen: 0,
			navGen: 1,
			tabId: "tab-1",
			tabGen: 1,
			policyRevision: 0,
		};
		runnerQueue.push(runner_web_session({ navGen: 2, tabGen: 2 }));
		const reloaded = await authed(t, fixture.userId).action(api.files_browser.reload_browser, {
			membershipId: fixture.membershipId,
			sessionId: started._yay.session.sessionId,
			path: "",
			expectedAgentLease,
		});
		expect(reloaded._yay).toEqual({ mode: "web", loadGen: 0, controlGen: 1, navGen: 2, tabId: "tab-1", tabGen: 2 });
		expect(runnerCalls.at(-1)?.body.expectedAgentLease).toEqual(expectedAgentLease);
		expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", started._yay.session.sessionId))).toMatchObject({
			navigationGeneration: 2,
			tabGen: 2,
			tabs: [{ tabId: "tab-1", tabGen: 2, navGen: 2 }],
		});
	});

	test.each([{ tabId: "other-tab" }, { controlGen: 3 }])(
		"refuses an agent reload reply with a changed lease: %j",
		async (changed) => {
			const t = test_convex();
			const fixture = await seed_web_member({ t });
			const started = await start_web_session({ t, fixture });
			if (started._nay) throw new Error(started._nay.message);
			const sessionId = started._yay.session.sessionId;
			const before = await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId));
			runnerQueue.push(runner_web_session({ navGen: 2, tabGen: 2, ...changed }));
			const reloaded = await authed(t, fixture.userId).action(api.files_browser.reload_browser, {
				membershipId: fixture.membershipId,
				sessionId,
				path: "",
				expectedAgentLease: {
					controlGen: 1,
					loadGen: 0,
					navGen: 1,
					tabId: "tab-1",
					tabGen: 1,
					policyRevision: 0,
				},
			});
			expect(reloaded._nay?.name).toBe("stale");
			expect(await t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toEqual(before);
		},
	);

	test("copies the runner generation and source instead of counting local reloads", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session({ t, fixture });
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
		const started = await start_saved_session({ t, fixture });
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
		const started = await start_saved_session({ t, fixture });
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
	test("a late viewer renew keeps the completed web navigation in the catalog", async () => {
		const t = test_convex();
		const fixture = await seed_web_member({ t });
		const started = await start_web_session({ t, fixture });
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;
		const source = await seed_browser_chat_source(t, fixture);
		const browserIntent = { policyRevision: 0 };
		const base = vi.mocked(fetch).getMockImplementation()!;
		let releaseRenew!: () => void;
		let startedRenew!: () => void;
		const waiting = new Promise<void>((resolve) => {
			releaseRenew = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			startedRenew = resolve;
		});
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			if (!String(input).endsWith("/internal/browser/viewer-renew")) return base(input, init);
			runnerCalls.push({ route: "viewer-renew", body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			startedRenew();
			await waiting;
			return Response.json({ ok: true, grantedUntil: Date.now() + 30_000, session: runner_web_session().session });
		});
		const asUser = authed(t, fixture.userId);
		const renewing = asUser.action(api.files_browser.renew_browser_viewer, {
			membershipId: fixture.membershipId,
			sessionId,
			viewerId: "viewer-1",
		});
		await reached;
		runnerQueue.push(runner_web_session({ navGen: 2, tabGen: 2 }));
		const reloaded = await asUser.action(api.files_browser.reload_browser, {
			membershipId: fixture.membershipId,
			sessionId,
			path: "",
			expectedAgentLease: {
				controlGen: 1,
				loadGen: 0,
				navGen: 1,
				tabId: "tab-1",
				tabGen: 1,
				policyRevision: 0,
			},
		});
		expect(reloaded._yay).toMatchObject({ navGen: 2, tabGen: 2 });
		releaseRenew();
		expect((await renewing)._nay).toBeUndefined();
		const catalog = await t.query(internal.files_browser.get_agent_browser_catalog, { source, browserIntent });
		expect(catalog._yay?.browsers[0]?.resource).toMatchObject({ sessionId, navGen: 2, tabGen: 2 });
		const checked = await t.query(internal.files_browser.check_browser_session_access, {
			...fixture,
			sessionId,
			tabId: "tab-1",
		});
		expect(checked).toMatchObject({ ok: true, navGen: 2, tabGen: 2 });
	});

	test("merges source and control separately when replies arrive out of order", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const started = await start_saved_session({ t, fixture });
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
		const started = await start_saved_session({ t, fixture });
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
		const started = await start_saved_session({ t, fixture });
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
		const started = await start_saved_session({ t, fixture });
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

describe("sync_browser_tab_identities", () => {
	test("a late public Tabs reply keeps the completed navigation of the other tab", async () => {
		const t = test_convex();
		const fixture = await seed_web_member({ t });
		await t.run((ctx) => ctx.db.patch("users", fixture.userId, { clerkUserId: "user_browser_tabs" }));
		const source = await seed_browser_chat_source(t, fixture);
		const begun = await t.mutation(internal.ai_chat.thread_run_begin, {
			source: {
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				threadId: source.threadId,
				membershipId: source.membershipId,
				membershipLifetime: source.membershipLifetime,
			},
			parentId: null,
			messages: [{ clientGeneratedMessageId: "run-user", content: { id: "run-user", role: "user", parts: [] } }],
			modeId: "ask",
			modelId: ai_chat_DEFAULT_MODEL_ID,
		});
		if (begun._nay) throw new Error(begun._nay.message);
		const run = { runId: begun._yay.runId, generation: begun._yay.generation };
		let commandNumber = 0;
		const browser: bash_BrowserContext = {
			source: {
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				membershipId: source.membershipId,
				membershipLifetime: source.membershipLifetime,
				threadId: source.threadId,
				sourceMessageId: source.sourceMessageId,
			},
			browserIntent: { policyRevision: 0 },
			run,
			canWriteFiles: false,
			invocationId: "bash-call" as Id<"ai_chat_bash_invocations">,
			deadlineAt: Date.now() + 240_000,
			signal: new AbortController().signal,
			nextCommandNumber: () => commandNumber++,
		};
		await t.action(async (ctx) => {
			const command = bash_browser_command_create(ctx, browser);
			const exec = (args: string[]) => command.execute(args, createCommandContext({ fs: new InMemoryFs(), cwd: "/" }));
			runnerQueue.push(runner_web_session());
			expect(await exec(["open"])).toMatchObject({ exitCode: 0 });
			const turn = await ctx.runQuery(internal.ai_chat_files.get_browser_turn, { run, userId: source.userId });
			const opened = turn._yay?.bindings[0];
			if (opened?.provider !== "cloud") throw new Error("Expected the cloud browser");
			const sessionId = opened.sessionId;
			const tabs = [
				{ tabId: "tab-1", tabGen: 1, navGen: 1, title: "A", url: "https://example.com/a" },
				{ tabId: "tab-2", tabGen: 1, navGen: 1, title: "B", url: "https://example.com/b" },
			];
			// Each command first checks its bindings with a runner status call.
			runnerQueue.push({ ...runner_web_session(), alive: true, profileStored: false });
			runnerQueue.push({
				...runner_web_session({ controlGen: 2, tabCount: 2 }),
				tabs,
				status: "completed",
				result: { tabId: "tab-2", reason: null, cleanup: "complete" },
			});
			expect(await exec(["tab", "new", "https://example.com/b"])).toMatchObject({ exitCode: 0 });

			const base = vi.mocked(fetch).getMockImplementation()!;
			let releaseTabs!: () => void;
			let startedTabs!: () => void;
			const waiting = new Promise<void>((resolve) => {
				releaseTabs = resolve;
			});
			const reached = new Promise<void>((resolve) => {
				startedTabs = resolve;
			});
			vi.mocked(fetch).mockImplementation(async (input, init) => {
				const route = String(input).split("/").at(-1)!;
				if (!["tabs", "run", "status"].includes(route)) return base(input, init);
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				runnerCalls.push({ route, body });
				if (route === "tabs") {
					startedTabs();
					await waiting;
					return Response.json({ ...runner_web_session({ controlGen: 2, tabCount: 2 }), tabs });
				}
				if (route === "status")
					return Response.json({
						...runner_web_session({ controlGen: 2, tabCount: 2 }),
						alive: true,
						profileStored: false,
					});
				return Response.json({
					ok: true,
					status: "succeeded",
					commandId: body.commandId,
					codeHash: await crypto_sha256_hex(`browser-v3\n${String(body.code)}`),
					elapsedMs: 10,
					result: "B",
					resultTruncated: false,
					files: [],
					consoleEntries: [],
					pageErrors: [],
					logs: [],
					logsTruncated: false,
					error: null,
					session: runner_web_session({ controlGen: 2, tabCount: 2, tabId: "tab-2", navGen: 2, tabGen: 2 }).session,
				});
			});
			const asUser = authed(t, fixture.userId);
			const listing = asUser.action(api.files_browser.list_browser_tabs, {
				membershipId: fixture.membershipId,
				sessionId,
			});
			await reached;
			try {
				expect(
					await exec([
						"run",
						"--tab",
						"tab-2",
						"-e",
						"await page.goto('https://example.com/next'); return await page.title();",
					]),
				).toEqual({ stdout: "B\n", stderr: "", exitCode: 0 });
				const completed = await t.run((readCtx) => readCtx.db.get("files_browser_sessions", sessionId));
				if (completed?.mode !== "web") throw new Error("Expected the completed web navigation");
				expect(completed.tabs.find((tab) => tab.tabId === "tab-2")).toEqual({
					tabId: "tab-2",
					tabGen: 2,
					navGen: 2,
				});
				expect(completed.viewedTabId).toBe("tab-1");
			} finally {
				releaseTabs();
				await listing;
			}
			expect((await listing)._nay).toBeUndefined();
			const stored = await t.run((readCtx) => readCtx.db.get("files_browser_sessions", sessionId));
			if (stored?.mode !== "web") throw new Error("Expected the live web browser");
			expect(
				stored.tabs.find((tab) => tab.tabId === "tab-2"),
				"late Tabs must keep B's completed navigation",
			).toEqual({
				tabId: "tab-2",
				tabGen: 2,
				navGen: 2,
			});
			expect(stored).toMatchObject({ tabId: "tab-1", viewedTabId: "tab-1", controlGen: 2 });

			// The late listing is not a person's change, so the turn keeps its access.
			expect(await exec(["run", "--tab", "tab-2", "-e", "return await page.title();"])).toEqual({
				stdout: "B\n",
				stderr: "",
				exitCode: 0,
			});
			expect(
				(await ctx.runQuery(internal.ai_chat_files.get_browser_turn, { run, userId: source.userId }))._yay?.revoked,
			).toBe(false);
			expect(runnerCalls.filter((call) => call.route === "run").at(-1)?.body).toMatchObject({
				tabId: "tab-2",
				tabGen: 2,
				navGen: 2,
				controlGen: 2,
			});
			runnerQueue.push({
				...runner_web_session({ controlGen: 3 }),
				tabs: [tabs[0]],
				status: "completed",
				result: { tabId: "tab-2", reason: null, cleanup: "complete" },
			});
			expect(
				(
					await asUser.action(api.files_browser.close_browser_tab, {
						membershipId: fixture.membershipId,
						sessionId,
						tabId: "tab-2",
						viewerId: "viewer-1",
					})
				)._yay?.status,
			).toBe("completed");
			const closedTab = await t.run((readCtx) => readCtx.db.get("files_browser_sessions", sessionId));
			if (closedTab?.mode !== "web") throw new Error("Expected the remaining web tab");
			expect(closedTab.tabs).toEqual([{ tabId: "tab-1", tabGen: 1, navGen: 1 }]);
		});
	});
});
