import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { ai_chat_runs_db_insert_node, ai_chat_runs_db_plan_step } from "./ai_chat_runs.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";
import { ai_chat_message_fits_storage } from "../server/ai-chat-tool-budget.ts";
import { ai_chat_tool_output_keep, ai_chat_tool_output_reserve } from "../server/ai-chat-tool-output.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";

const TRANSCRIPT_PATH = "/api/v1/ai-chat/threads/transcript";
const OUTPUT_PATH = "/api/v1/ai-chat/threads/tool-output/read";
const encoder = new TextEncoder();
let uploads: Map<string, Uint8Array<ArrayBuffer>>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
	uploads = new Map();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: `https://r2.test/${encodeURIComponent(key!)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key) => `https://r2.test/${encodeURIComponent(key)}`);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
			if (request.method === "PUT") {
				uploads.set(key, new Uint8Array(await request.arrayBuffer()));
				return new Response(null, { status: 200 });
			}
			const bytes = uploads.get(key);
			if (!bytes) return new Response(null, { status: 404 });
			const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get("Range") ?? "");
			if (!range) return new Response(bytes, { status: 200 });
			const start = Number(range[1]);
			const end = Math.min(Number(range[2]), bytes.byteLength - 1);
			return new Response(bytes.slice(start, end + 1), {
				status: 206,
				headers: { "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}` },
			});
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-ai-transcript" });
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const key = await asUser.mutation(api.public_api.api_credential_create, {
		membershipId: db.membershipId,
		serviceAccountId: null,
		name: "Transcript test",
		scopes: ["ai_chat:read"],
	});
	if (key._nay) throw new Error(key._nay.message);
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "transcript-thread",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const source = { ...db, threadId: thread._yay.threadId, membershipLifetime: captured._yay.membershipLifetime };
	const request = async (path: string, body: Record<string, unknown>, token = key._yay.credential) => {
		// Refill request buckets without running unrelated scheduled jobs.
		vi.setSystemTime(Date.now() + 2_000);
		const response = await t.fetch(path, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ threadId: source.threadId, ...body }),
		});
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		return response;
	};
	return { t, db, asUser, source, key: key._yay, request };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Run = Awaited<ReturnType<typeof begin_turn>>;
type Fragment = {
	messageId: string;
	parentId: string | null;
	clientGeneratedMessageId: string;
	role: string;
	status: "streaming" | "done" | "stopped" | "failed";
	version: number;
	stepIndex: number | null;
	stepStatus: "tools_running" | "done" | "partial" | null;
	parts: Array<Record<string, unknown>>;
};
type Page = {
	kind: "header" | "fragment";
	thread?: { id: string; title: string | null; endMessageId: string | null };
	endMessageId?: string;
	fragment: Fragment | null;
	cursor: string | null;
	isDone: boolean;
};

async function begin_turn(f: Fixture, id: string, parentId: string | null = null, parts?: unknown[]) {
	const begun = await f.t.mutation(internal.ai_chat.thread_run_begin, {
		source: f.source,
		parentId,
		messages: [
			{ clientGeneratedMessageId: id, content: { id, role: "user", parts: parts ?? [{ type: "text", text: id }] } },
		],
		modeId: "ask",
		modelId: ai_chat_DEFAULT_MODEL_ID,
	});
	if (begun._nay) throw new Error(begun._nay.message);
	return begun._yay;
}

async function save_step(f: Fixture, run: Run, stepIndex: number, text: string) {
	expect(
		await f.t.mutation(internal.ai_chat_runs.step_complete, {
			runId: run.runId,
			generation: run.generation,
			stepIndex,
			parts: [{ type: "step-start" }, { type: "text", text, state: "done" }],
			finishReason: "stop",
		}),
	).toEqual({ saved: true });
}

async function finish(f: Fixture, run: Run, outcome: "done" | "stopped" | "failed" = "done") {
	await f.t.mutation(internal.ai_chat_runs.finish, {
		runId: run.runId,
		generation: run.generation,
		outcome,
		tail: null,
	});
}

async function page(f: Fixture, body: Record<string, unknown> = {}, token?: string) {
	const response = await f.request(TRANSCRIPT_PATH, body, token);
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
	return JSON.parse(text) as Page;
}

async function collect(f: Fixture, body: Record<string, unknown> = {}) {
	const header = await page(f, body);
	expect(header.kind).toBe("header");
	expect(header.fragment).toBeNull();
	const fragments: Fragment[] = [];
	let current = header;
	while (!current.isDone) {
		expect(current.cursor).toBeTypeOf("string");
		current = await page(f, { ...body, cursor: current.cursor });
		expect(current.kind).toBe("fragment");
		expect(current.fragment).not.toBeNull();
		fragments.push(current.fragment!);
	}
	expect(current.cursor).toBeNull();
	return { header, fragments };
}

async function stored_output(f: Fixture, text = "😀é output€\n".repeat(4_000)) {
	const run = await begin_turn(f, "read the output");
	const kept = await f.t.action(async (ctx) => {
		const reservation = await ai_chat_tool_output_reserve(ctx, {
			source: f.source,
			getRun: () => ({ runId: run.runId, generation: run.generation }),
			getModelCallId: () => "transcript-output",
			toolCallId: "output-call",
			tool: "bash",
		});
		const kept = await ai_chat_tool_output_keep(ctx, {
			reservation,
			source: f.source,
			inlineText: text,
			storedText: text,
			contentType: "text/plain; charset=utf-8",
			sourceBytes: encoder.encode(text).byteLength,
			cutBy: [],
		});
		await ctx.runMutation(internal.ai_chat_outputs.release_reservation, { objectId: reservation.objectId });
		return kept;
	});
	if (!kept.ref) throw new Error("Expected a stored output");
	await f.t.mutation(internal.ai_chat_runs.step_complete, {
		runId: run.runId,
		generation: run.generation,
		stepIndex: 0,
		parts: [
			{
				type: "tool-bash",
				toolCallId: "output-call",
				state: "output-available",
				input: { command: "printf output" },
				output: { title: "exit 0", output: kept.output, metadata: { output: kept.ref } },
			},
		],
		finishReason: "tool-calls",
	});
	await finish(f, run);
	return { run, text, ref: kept.ref };
}

async function plugin_tokens(f: Fixture) {
	const capabilities = ["plugin.schedule.run", "plugin.data.read", "plugin.backend.invoke"] as const;
	const pluginVersionId = await f.t.run((ctx) =>
		ctx.db.insert("plugins_versions", {
			name: "transcript-test",
			displayName: "Transcript test",
			version: "0.1.0",
			description: "API refusal fixture",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/example/transcript-test",
			sourceOwner: "example",
			sourceRepo: "transcript-test",
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: "plugins/transcript-test/manifest.json",
			backendEntrypointFile: {
				entry: "backend.js",
				moduleName: "backend",
				r2Key: "plugins/transcript-test/backend.js",
				sha256: "a".repeat(64),
				compatibilityDate: "2026-01-01",
				compatibilityFlags: [],
			},
			configuration: { description: "Schedule", defaultYaml: "schedule:\n  everyMinutes: 15\n" },
			mounts: [],
			events: [
				{
					type: "schedule.interval.elapsed",
					contentTypes: [],
					filters: [],
					schedule: { configurationPath: ["schedule", "everyMinutes"] },
				},
			],
			capabilities: [...capabilities],
			endpoints: [{ id: "echo", path: "/echo", serialization: "installation" }],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "transcript-mcp",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: f.db.userId,
			updatedAt: Date.now(),
			secrets: [],
			userWritableCollections: null,
		}),
	);
	const installed = await f.asUser.mutation(api.plugins.install_version, {
		membershipId: f.db.membershipId,
		pluginVersionId,
		acceptedCapabilities: [...capabilities],
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		acceptedMcpServersFingerprint: "transcript-mcp",
		acceptedSkillNames: [],
		scheduledRun: { kind: "me", scopes: ["plugin_data:read"] },
	});
	if (installed._nay) throw new Error(installed._nay.message);
	const installation = (await f.t.run((ctx) =>
		ctx.db.get("plugins_workspace_installations", installed._yay.installationId),
	))!;
	const invokeToken = `plr_${crypto_random_hex(32)}`;
	const invoked = await f.t.mutation(internal.plugins_runtime.start_invoke_run, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		installationId: installation._id,
		serviceAccountId: installation.serviceAccountId,
		pluginVersionId,
		endpointId: "echo",
		callerSerializationKey: null,
		apiTokenHash: await crypto_sha256_hex(invokeToken),
	});
	if (invoked._nay) throw new Error(invoked._nay.message);
	await f.t.run(async (ctx) => {
		const handler = await ctx.db
			.query("plugins_workspace_event_handlers")
			.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
			.first();
		await ctx.db.patch("plugins_workspace_event_handlers", handler!._id, { nextRunAt: Date.now() });
	});
	await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
	const scheduledRun = (await f.t.run((ctx) =>
		ctx.db
			.query("plugins_event_runs")
			.withIndex("by_asset_event_installation", (q) =>
				q.eq("assetId", undefined).eq("event", "schedule.interval.elapsed").eq("installationId", installation._id),
			)
			.first(),
	))!;
	const scheduledToken = `plr_${crypto_random_hex(32)}`;
	const started = await f.t.mutation(internal.plugins_runtime.start_event_run, {
		runId: scheduledRun._id,
		apiTokenHash: await crypto_sha256_hex(scheduledToken),
	});
	if (started._nay) throw new Error(started._nay.message);
	return { invokeToken, scheduledToken, invokeRunId: invoked._yay.pluginRun._id };
}

describe("AI transcript API", () => {
	test("refuses valid ordinary and scheduled plugin tokens through both routes", async () => {
		const f = await fixture();
		const tokens = await plugin_tokens(f);
		for (const token of [tokens.invokeToken, tokens.scheduledToken]) {
			await expect(f.request(TRANSCRIPT_PATH, {}, token)).resolves.toHaveProperty("status", 403);
			await expect(f.request(OUTPUT_PATH, { outputId: "not-an-output", offset: 0 }, token)).resolves.toHaveProperty(
				"status",
				403,
			);
		}
		const calls = await f.t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", tokens.invokeRunId))
				.collect(),
		);
		expect(calls.map((call) => [call.route, call.status, call.responseStatus])).toEqual([
			[TRANSCRIPT_PATH, "failed", 403],
			[OUTPUT_PATH, "failed", 403],
		]);
	});
	test("returns a finished header for an empty thread", async () => {
		const f = await fixture();
		expect(await page(f)).toMatchObject({
			kind: "header",
			thread: { id: f.source.threadId, endMessageId: null },
			fragment: null,
			cursor: null,
			isDone: true,
		});
	});

	test("uses the normal CORS preflight and denies oversized or invalid JSON bodies", async () => {
		const f = await fixture();
		const origin = new URL(process.env.ALLOWED_ORIGINS!.split(",")[0]!).origin;
		for (const path of [TRANSCRIPT_PATH, OUTPUT_PATH]) {
			const preflight = await f.t.fetch(path, {
				method: "OPTIONS",
				headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
			for (const [body, declaredLength] of [
				["{}", "32769"],
				["{", "1"],
			]) {
				const response = await f.t.fetch(path, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${f.key.credential}`,
						Origin: origin,
						"Content-Type": "application/json",
						"Content-Length": declaredLength!,
					},
					body,
				});
				expect(response.status).toBe(400);
				expect(response.headers.get("Cache-Control")).toBe("no-store");
				expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
			}
		}
	});

	test("exports one branch with all reply steps, saved ids, and exact parent links", async () => {
		const f = await fixture();
		const first = await begin_turn(f, "first");
		await save_step(f, first, 0, "first answer");
		await finish(f, first);
		const second = await begin_turn(f, "second", first.replyId);
		await save_step(f, second, 0, "step zero");
		await save_step(f, second, 1, "step one");
		await finish(f, second);
		const edit = await begin_turn(f, "edited second", first.replyId);
		await save_step(f, edit, 0, "alternate answer");
		await finish(f, edit);
		const { header, fragments } = await collect(f, { endMessageId: second.replyId });
		expect(header.thread?.endMessageId).toBe(second.replyId);
		expect(fragments.map((fragment) => [fragment.messageId, fragment.stepIndex, fragment.parentId])).toEqual([
			[second.replyId, 1, second.triggerId],
			[second.replyId, 0, second.triggerId],
			[second.triggerId, null, first.replyId],
			[first.replyId, 0, first.triggerId],
			[first.triggerId, null, null],
		]);
		expect(
			fragments
				.flatMap((fragment) => fragment.parts)
				.filter((part) => part.type === "text")
				.map((part) => part.text),
		).toEqual(["step one", "step zero", "second", "first answer", "first"]);
		expect(fragments[0]).toMatchObject({ role: "assistant", status: "done", stepStatus: "done" });
		expect(fragments[2]?.clientGeneratedMessageId).toBe("second");
		const latest = await page(f);
		expect(latest.thread?.endMessageId).toBe(edit.replyId);
	});

	test("pins the first header's end while new messages arrive", async () => {
		const f = await fixture();
		const first = await begin_turn(f, "first");
		await finish(f, first);
		const header = await page(f);
		await begin_turn(f, "later", first.replyId);
		const next = await page(f, { cursor: header.cursor });
		expect(next.endMessageId).toBe(first.replyId);
		expect(next.fragment).toMatchObject({ messageId: first.replyId, parts: [], status: "done" });
	});

	test("keeps stopped and failed empty replies", async () => {
		const f = await fixture();
		const stopped = await begin_turn(f, "stop");
		await finish(f, stopped, "stopped");
		const failed = await begin_turn(f, "fail", stopped.replyId);
		await finish(f, failed, "failed");
		const { fragments } = await collect(f);
		expect(fragments.filter((fragment) => fragment.role === "assistant")).toMatchObject([
			{ messageId: failed.replyId, parts: [], status: "failed" },
			{ messageId: stopped.replyId, parts: [], status: "stopped" },
		]);
	});

	test("exports empty planned steps and every saved step in a long reply", async () => {
		const f = await fixture();
		const run = await begin_turn(f, "many steps");
		for (let stepIndex = 0; stepIndex < 24; stepIndex++) await save_step(f, run, stepIndex, `step ${stepIndex}`);
		await f.t.run((ctx) =>
			ai_chat_runs_db_plan_step(ctx, {
				runId: run.runId,
				generation: run.generation,
				stepIndex: 24,
				modelCallId: "planned-only",
				toolCalls: [],
			}),
		);
		const { fragments } = await collect(f);
		expect(fragments[0]).toMatchObject({
			messageId: run.replyId,
			status: "streaming",
			stepIndex: 24,
			stepStatus: "tools_running",
			parts: [],
		});
		expect(fragments).toHaveLength(26);
		expect(fragments.slice(1, -1).map((fragment) => fragment.parts[1]?.text)).toEqual(
			Array.from({ length: 24 }, (_, index) => `step ${23 - index}`),
		);
	});

	test("rejects a version change while paging a reply and excludes later empty planned steps", async () => {
		const f = await fixture();
		const run = await begin_turn(f, "long answer");
		await save_step(f, run, 0, "zero");
		await save_step(f, run, 1, "one");
		const header = await page(f);
		const top = await page(f, { cursor: header.cursor });
		expect(top.fragment?.stepIndex).toBe(1);
		await f.t.run((ctx) =>
			ai_chat_runs_db_plan_step(ctx, {
				runId: run.runId,
				generation: run.generation,
				stepIndex: 2,
				modelCallId: "next-model-call",
				toolCalls: [],
			}),
		);
		const lower = await page(f, { cursor: top.cursor });
		expect(lower.fragment?.stepIndex).toBe(0);
		await save_step(f, run, 2, "new saved step");
		const changed = await f.request(TRANSCRIPT_PATH, { cursor: top.cursor });
		expect(changed.status).toBe(409);
		expect(await changed.json()).toMatchObject({ errorCode: "transcript_changed" });
	});

	test("exports copied steps even when the copied nodes have no run id", async () => {
		const f = await fixture();
		const run = await begin_turn(f, "copy this");
		await save_step(f, run, 0, "copied zero");
		await save_step(f, run, 1, "copied one");
		await finish(f, run);
		const copied = await f.asUser.action(api.ai_chat.thread_branch, {
			membershipId: f.db.membershipId,
			threadId: f.source.threadId,
		});
		if (copied._nay) throw new Error(copied._nay.message);
		const { fragments } = await collect(f, { threadId: copied._yay.threadId });
		expect(fragments.map((fragment) => fragment.stepIndex)).toEqual([1, 0, null]);
		expect(fragments[0]?.parts).toContainEqual({ type: "text", text: "copied one", state: "done" });
		const node = await f.t.run((ctx) =>
			ctx.db.get("ai_chat_threads_messages_aisdk_5", fragments[0]!.messageId as Id<"ai_chat_threads_messages_aisdk_5">),
		);
		expect(node?.runId).toBeNull();
	});

	test("continues past the UI's ancestry limit without replacing saved text with a summary", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			const thread = (await ctx.db.get("ai_chat_threads", f.source.threadId))!;
			let parentId: Id<"ai_chat_threads_messages_aisdk_5"> | null = null;
			for (let index = 0; index < 260; index++) {
				parentId = await ai_chat_runs_db_insert_node(ctx, {
					thread,
					parentId,
					createdBy: f.db.userId,
					clientGeneratedMessageId: `message-${index}`,
					content: { id: `message-${index}`, role: "user", parts: [{ type: "text", text: `message-${index}` }] },
					status: "done",
					runId: null,
					wakePending: false,
					jobFinishInvocationId: null,
					newest: "set",
					now: Date.now(),
				});
			}
		});
		const { fragments } = await collect(f);
		expect(fragments).toHaveLength(260);
		expect(fragments[0]?.parts).toEqual([{ type: "text", text: "message-259" }]);
		expect(fragments.at(-1)?.parts).toEqual([{ type: "text", text: "message-0" }]);
	}, 60_000);

	test("separates a large title from whole large message and step bodies", async () => {
		const f = await fixture();
		const title = "\u0000".repeat(850_000);
		await f.asUser.mutation(api.ai_chat.thread_update, {
			membershipId: f.db.membershipId,
			threadId: f.source.threadId,
			title,
		});
		const text = '"\\\n'.repeat(153_000);
		expect(ai_chat_message_fits_storage({ id: "large", role: "user", parts: [{ type: "text", text }] })).toBe(true);
		const run = await begin_turn(f, "large", null, [{ type: "text", text }]);
		await save_step(f, run, 0, text);
		await finish(f, run);
		const { header, fragments } = await collect(f);
		expect(header.thread?.title).toBe(title);
		expect(fragments[0]?.parts).toContainEqual({ type: "text", text, state: "done" });
		expect(fragments[1]?.parts).toEqual([{ type: "text", text }]);
	});

	test("preserves sent quote text after the linked file becomes unavailable", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				kind: "file",
				name: "quoted.md",
				path: "/quoted.md",
				treePath: "/quoted.md",
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
			}),
		);
		const run = await begin_turn(f, "quote", null, [
			{ type: "data-file-quote", data: { fileNodeId, text: "Sent words" } },
		]);
		await finish(f, run);
		await f.t.run((ctx) => ctx.db.patch("files_nodes", fileNodeId, { archiveOperationId: "archived" }));
		const { fragments } = await collect(f);
		expect(fragments.at(-1)?.parts).toEqual([
			{ type: "data-file-quote", data: { fileNodeId: null, text: "Sent words" } },
		]);
	});

	test("refuses tampered, other-key, and mismatched-end cursors", async () => {
		const f = await fixture();
		const run = await begin_turn(f, "first");
		await finish(f, run);
		const header = await page(f);
		const otherKey = await f.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: null,
			name: "Other export",
			scopes: ["ai_chat:read"],
		});
		if (otherKey._nay) throw new Error(otherKey._nay.message);
		const otherThread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "other-cursor-thread",
			lastMessageAt: Date.now(),
		});
		if (otherThread._nay) throw new Error(otherThread._nay.message);
		for (const [body, token] of [
			[{ cursor: `${header.cursor!.slice(0, 20)}!` }, f.key.credential],
			[{ cursor: header.cursor }, otherKey._yay.credential],
			[{ cursor: header.cursor, endMessageId: run.triggerId }, f.key.credential],
			[{ cursor: header.cursor, threadId: otherThread._yay.threadId }, f.key.credential],
		] as const) {
			const response = await f.request(TRANSCRIPT_PATH, body, token);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ errorCode: "invalid_cursor" });
		}
		expect(
			(await f.request(TRANSCRIPT_PATH, { threadId: otherThread._yay.threadId, endMessageId: run.replyId })).status,
		).toBe(404);
	});

	test("allows archived guest-owned chats and outputs but refuses lost access", async () => {
		const f = await fixture();
		const output = await stored_output(f);
		await f.t.run(async (ctx) => {
			const ownerId = await ctx.db.insert("users", { clerkUserId: "clerk-other-owner" });
			await ctx.db.patch("organizations", f.db.organizationId, { ownerUserId: ownerId });
			const assignments = await ctx.db.query("access_control_role_assignments").collect();
			for (const assignment of assignments)
				if (assignment.userId === f.db.userId && assignment.organizationId === f.db.organizationId)
					await ctx.db.delete("access_control_role_assignments", assignment._id);
		});
		expect(
			await f.asUser.mutation(api.ai_chat.thread_update, {
				membershipId: f.db.membershipId,
				threadId: f.source.threadId,
				isArchived: true,
			}),
		).toEqual({ _yay: null });
		expect((await page(f)).thread?.id).toBe(f.source.threadId);
		expect((await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 0, limit: 4 })).status).toBe(200);
		for (const fence of ["deletingAt", "copyingAt"] as const) {
			await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.source.threadId, { [fence]: Date.now() }));
			expect((await f.request(TRANSCRIPT_PATH, {})).status).toBe(404);
			await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.source.threadId, { [fence]: undefined }));
		}
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect((await f.request(TRANSCRIPT_PATH, {})).status).toBe(401);
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: true }));
		await f.asUser.mutation(api.public_api.api_credential_revoke, {
			membershipId: f.db.membershipId,
			credentialId: f.key.credentialId,
		});
		expect((await f.request(TRANSCRIPT_PATH, {})).status).toBe(401);
	});

	test("returns the same 404 for another creator and a missing conversation", async () => {
		const f = await fixture();
		const foreignThread = await f.t.run(async (ctx) => {
			const otherId = await ctx.db.insert("users", { clerkUserId: "clerk-other-creator" });
			const source = (await ctx.db.get("ai_chat_threads", f.source.threadId))!;
			const { _id: _id, _creationTime: _creationTime, ...fields } = source;
			return await ctx.db.insert("ai_chat_threads", {
				...fields,
				createdBy: otherId,
				updatedBy: otherId,
				clientGeneratedId: "other-thread",
			});
		});
		const denied = await f.request(TRANSCRIPT_PATH, { threadId: foreignThread });
		expect(denied.status).toBe(404);
		await f.t.run((ctx) => ctx.db.delete("ai_chat_threads", foreignThread));
		const missing = await f.request(TRANSCRIPT_PATH, { threadId: foreignThread });
		expect(missing.status).toBe(404);
		expect(await denied.json()).toEqual(await missing.json());
	});

	test("rejects malformed requests, wrong scopes, bound keys, and another workspace", async () => {
		const f = await fixture();
		const filesKey = await f.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: null,
			name: "Files only",
			scopes: ["files:read"],
		});
		if (filesKey._nay) throw new Error(filesKey._nay.message);
		expect((await f.request(TRANSCRIPT_PATH, {}, filesKey._yay.credential)).status).toBe(403);
		expect((await f.request(TRANSCRIPT_PATH, {}, "bad-token")).status).toBe(401);
		expect((await f.request(TRANSCRIPT_PATH, { threadId: "not-an-id" })).status).toBe(400);
		expect((await f.request(TRANSCRIPT_PATH, { cursor: "x".repeat(16_385) })).status).toBe(400);
		expect((await f.request(TRANSCRIPT_PATH, { padding: "x".repeat(32 * 1024) })).status).toBe(400);
		const account = await f.asUser.mutation(api.access_control.create_service_account, {
			membershipId: f.db.membershipId,
			name: "Bound reader",
		});
		if (account._nay) throw new Error(account._nay.message);
		vi.setSystemTime(Date.now() + 20_000);
		const boundKey = await f.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: account._yay.serviceAccountId,
			name: "Bound key",
			scopes: ["files:read"],
		});
		if (boundKey._nay) throw new Error(boundKey._nay.message);
		expect((await f.request(TRANSCRIPT_PATH, {}, boundKey._yay.credential)).status).toBe(403);
		const foreign = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { userId: f.db.userId, organizationName: "foreign" }),
		);
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: foreign.membershipId,
			clientGeneratedId: "foreign",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		expect((await f.request(TRANSCRIPT_PATH, { threadId: thread._yay.threadId })).status).toBe(404);
	});

	test("ends a cursor when the membership lifetime changes and denies the purge fence", async () => {
		const f = await fixture();
		const run = await begin_turn(f, "first");
		await finish(f, run);
		const header = await page(f);
		await f.t.run(async (ctx) => {
			const lifetime = await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.db.workspaceId).eq("userId", f.db.userId))
				.first();
			await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, { lifetime: lifetime!.lifetime + 1 });
		});
		const invalid = await f.request(TRANSCRIPT_PATH, { cursor: header.cursor });
		expect(invalid.status).toBe(401);
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.db.workspaceId, { pluginDataPurgeStartedAt: Date.now() }),
		);
		expect((await f.request(TRANSCRIPT_PATH, {})).status).toBe(404);
	});

	test("rate-limits authenticated pages with a retry delay", async () => {
		const f = await fixture();
		let limited: Response | null = null;
		for (let index = 0; index < 25; index++) {
			const response = await f.t.fetch(TRANSCRIPT_PATH, {
				method: "POST",
				headers: { Authorization: `Bearer ${f.key.credential}`, "Content-Type": "application/json" },
				body: JSON.stringify({ threadId: f.source.threadId }),
			});
			if (response.status === 429) {
				limited = response;
				break;
			}
			expect(response.status).toBe(200);
		}
		expect(limited).not.toBeNull();
		expect(limited!.headers.get("Cache-Control")).toBe("no-store");
		expect(await limited!.json()).toMatchObject({ retryAfterMs: expect.any(Number) });
	});
});

describe("AI stored output API", () => {
	test("skips a split character without decoding the next partial character", async () => {
		const f = await fixture();
		const output = await stored_output(f, "😀a😀z".repeat(4_000));
		const first = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 1, limit: 4 });
		expect(await first.json()).toMatchObject({ text: "a", offset: 4, nextOffset: 5 });
		const second = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 5, limit: 4 });
		expect(await second.json()).toMatchObject({ text: "😀", offset: 5, nextOffset: 9 });
		const third = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 9, limit: 4 });
		expect(await third.json()).toMatchObject({ text: "z", offset: 9, nextOffset: 10 });
	});

	test("pages UTF-8 exactly, advances at the minimum limit, adjusts a split start, and ends at EOF", async () => {
		const f = await fixture();
		const output = await stored_output(f);
		const read = (body: Record<string, unknown>) => f.request(OUTPUT_PATH, { outputId: output.ref.outputId, ...body });
		const first = await read({ offset: 0, limit: 4 });
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ text: "😀", offset: 0, nextOffset: 4 });
		const adjusted = await read({ offset: 1, limit: 4 });
		expect(adjusted.status).toBe(200);
		expect(await adjusted.json()).toMatchObject({ text: "é o", offset: 4, nextOffset: 8 });
		let offset = 0;
		let text = "";
		const totalBytes = encoder.encode(output.text).byteLength;
		while (offset < totalBytes) {
			const response = await read({ offset });
			expect(response.status).toBe(200);
			const body = (await response.json()) as { text: string; offset: number; nextOffset: number; totalBytes: number };
			expect(body.offset).toBe(offset);
			expect(body.nextOffset).toBeGreaterThan(offset);
			expect(body.totalBytes).toBe(totalBytes);
			text += body.text;
			offset = body.nextOffset;
		}
		expect(text).toBe(output.text);
		const eof = await read({ offset });
		expect(await eof.json()).toEqual({ text: "", offset, nextOffset: offset, totalBytes });
		expect((await read({ offset: offset + 1 })).status).toBe(400);
		for (const limit of [0, 1, 3, 4.5, 65_537]) expect((await read({ offset: 0, limit })).status).toBe(400);
		for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
			expect((await read({ offset, limit: 4 })).status).toBe(400);
	});

	test("accepts a bounded whole-object response and preserves output references", async () => {
		const f = await fixture();
		// Escaping makes this result large enough to store while its bytes fit one range.
		const output = await stored_output(f, "\u0000".repeat(5_000));
		vi.mocked(fetch).mockImplementationOnce(async () => new Response(encoder.encode(output.text), { status: 200 }));
		const response = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 0 });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: output.text, offset: 0, nextOffset: 5_000, totalBytes: 5_000 });
		const { fragments } = await collect(f);
		expect(fragments[0]?.parts[0]).toMatchObject({
			type: "tool-bash",
			output: { metadata: { output: output.ref } },
		});
	});

	test("checks exact-thread committed ownership and keeps copied outputs after source deletion", async () => {
		const f = await fixture();
		const output = await stored_output(f);
		const copied = await f.asUser.action(api.ai_chat.thread_branch, {
			membershipId: f.db.membershipId,
			threadId: f.source.threadId,
		});
		if (copied._nay) throw new Error(copied._nay.message);
		vi.setSystemTime(Date.now() + 10_000);
		expect(
			await f.asUser.mutation(api.ai_chat.thread_delete, {
				membershipId: f.db.membershipId,
				threadId: f.source.threadId,
			}),
		).toEqual({ _yay: null });
		let done = false;
		for (let pass = 0; pass < 50 && !done; pass++) {
			done = (
				await f.t.mutation(internal.data_deletion.drain_deleting_thread, {
					threadId: f.source.threadId,
					_test_disableReschedule: true,
				})
			).done;
		}
		expect(done).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_threads", f.source.threadId))).toBeNull();
		const read = await f.request(OUTPUT_PATH, {
			threadId: copied._yay.threadId,
			outputId: output.ref.outputId,
			offset: 0,
			limit: 4,
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ text: "😀" });
		const unrelated = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "without-output",
			lastMessageAt: Date.now(),
		});
		if (unrelated._nay) throw new Error(unrelated._nay.message);
		expect(
			(await f.request(OUTPUT_PATH, { threadId: unrelated._yay.threadId, outputId: output.ref.outputId, offset: 0 }))
				.status,
		).toBe(404);
	});

	test.each(["key", "membership", "thread", "owner"] as const)(
		"returns no bytes after %s access changes during the range read",
		async (change) => {
			const f = await fixture();
			const output = await stored_output(f);
			const serve = vi.mocked(fetch).getMockImplementation()!;
			vi.mocked(fetch).mockImplementationOnce(async (input, init) => {
				const response = await serve(input, init);
				await f.t.run(async (ctx) => {
					if (change === "key") await ctx.db.patch("api_credentials", f.key.credentialId, { revokedAt: Date.now() });
					if (change === "membership") {
						const lifetime = await ctx.db
							.query("organizations_membership_lifetimes")
							.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.db.workspaceId).eq("userId", f.db.userId))
							.first();
						await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, {
							lifetime: lifetime!.lifetime + 1,
						});
					}
					if (change === "thread") await ctx.db.patch("ai_chat_threads", f.source.threadId, { deletingAt: Date.now() });
					if (change === "owner") {
						const owner = await ctx.db
							.query("ai_chat_output_owners")
							.withIndex("by_thread_object", (q) =>
								q.eq("threadId", f.source.threadId).eq("objectId", output.ref.outputId),
							)
							.first();
						await ctx.db.delete("ai_chat_output_owners", owner!._id);
					}
				});
				return response;
			});
			const response = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 0, limit: 4 });
			expect(response.status).not.toBe(200);
			expect(await response.json()).not.toHaveProperty("text");
		},
	);

	test.each(["missing range", "wrong range", "ignored range", "short body", "oversized body", "storage failure"])(
		"returns a plain error for %s",
		async (failure) => {
			const f = await fixture();
			const output = await stored_output(f);
			vi.mocked(fetch).mockImplementationOnce(async () => {
				if (failure === "storage failure") throw new Error("secret-r2-key: provider failure");
				return new Response(new Uint8Array(failure === "short body" ? 9 : failure === "oversized body" ? 11 : 10), {
					status: failure === "ignored range" ? 200 : 206,
					headers:
						failure === "missing range"
							? {}
							: {
									"Content-Range":
										failure === "wrong range" ? "bytes 0-9/1" : `bytes 0-9/${encoder.encode(output.text).byteLength}`,
								},
				});
			});
			const response = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 0, limit: 4 });
			expect(response.status).toBe(503);
			const body = await response.text();
			expect(body).not.toContain("secret-r2-key");
			expect(body).not.toContain("provider failure");
			expect(JSON.parse(body)).not.toHaveProperty("text");
		},
	);

	test("cancels a storage stream as soon as it exceeds the requested byte count", async () => {
		const f = await fixture();
		const output = await stored_output(f);
		let cancelled = false;
		vi.mocked(fetch).mockImplementationOnce(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(new Uint8Array(11));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 206, headers: { "Content-Range": `bytes 0-9/${encoder.encode(output.text).byteLength}` } },
				),
		);
		const response = await f.request(OUTPUT_PATH, { outputId: output.ref.outputId, offset: 0, limit: 4 });
		expect(response.status).toBe(503);
		expect(await response.json()).not.toHaveProperty("text");
		expect(cancelled).toBe(true);
	});
});
