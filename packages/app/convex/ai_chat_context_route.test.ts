import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { streamText } from "ai";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({ ...await importOriginal<typeof import("ai")>(), streamText: model.streamText }));

beforeEach(() => {
	model.streamText.mockReset();
	model.streamText.mockImplementation(() => ({
		toUIMessageStream: () => new ReadableStream({
			start(controller) {
				controller.enqueue({ type: "start", messageId: "answer" });
				controller.enqueue({ type: "text-start", id: "text" });
				controller.enqueue({ type: "text-delta", id: "text", delta: "Done" });
				controller.enqueue({ type: "text-end", id: "text" });
				controller.enqueue({ type: "finish" });
				controller.close();
			},
		}),
		response: Promise.resolve({ messages: [] }),
		consumeStream: async () => {},
	}));
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_skill_route_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async key => ({ key: key ?? "test", url: `https://r2.test/upload?key=${encodeURIComponent(key ?? "test")}` }));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async key => `https://r2.test/object?key=${encodeURIComponent(key)}`);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	const objects = new Map<string, BodyInit>();
	vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const key = url.searchParams.get("key") ?? "";
		if (init?.method === "PUT") {
			objects.set(key, init.body ?? "");
			return new Response(null, { status: 200 });
		}
		const body = objects.get(key);
		return new Response(body ?? null, { status: body === undefined ? 404 : 200 });
	}));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup() {
	const t = test_convex();
	const membership = await t.run(ctx => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: "skill-route", external_id: membership.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: membership.membershipId, clientGeneratedId: "skill-route-thread", title: "Skill check", lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	return { t, asUser, membership, threadId: thread._yay.threadId };
}

describe("/api/chat workspace instructions", () => {
	test("starts with pending root rules and a catalog, then reads skills and ancestor rules through Bash", async () => {
		const { t, asUser, membership, threadId } = await setup();
		const { organizationId, workspaceId, userId } = membership;
		const scope = { organizationId, workspaceId, userId };
		const root = await t.action(internal.files_nodes_content.create_file_by_path, { ...scope, path: "/AGENTS.md", textContent: "ROOT_GUIDANCE_271" });
		const nested = await t.action(internal.files_nodes_content.create_file_by_path, { ...scope, path: "/invoices/AGENTS.md", textContent: "NESTED_GUIDANCE_272" });
		const skill = await t.action(internal.files_nodes_content.create_file_by_path, {
			...scope, path: "/.agents/skills/summarize-invoices/SKILL.md",
			textContent: "---\nname: summarize-invoices\ndescription: CATALOG_DESCRIPTION_273\n---\n\nSECRET_SKILL_BODY_274",
		});
		if (root._nay || nested._nay || skill._nay) throw new Error("Fixture files must be created");

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, { ...scope, nodeId: root._yay.nodeId });
		if (batch._nay) throw new Error(batch._nay.message);
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope, operationBatchId: batch._yay.operationBatchId, role: "unstaged", text: "UNSAVED_GUIDANCE_275",
		});
		if (staged._nay) throw new Error(staged._nay.message);
		const pending = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			...scope, nodeId: root._yay.nodeId, operationBatchId: batch._yay.operationBatchId,
		});
		if (pending._nay) throw new Error(pending._nay.message);
		const proposals = await t.run(ctx => ctx.db.query("files_pending_updates").withIndex("by_fileNode", q => q.eq("fileNodeId", root._yay.nodeId)).collect());
		expect(proposals).toHaveLength(1);

		const response = await asUser.fetch("/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ id: "user-message", role: "user", parts: [{ type: "text", text: "Summarize invoices." }] }],
				parentId: null, mode: "ask", model: "gpt-5.4-nano", trigger: "submit-message", threadId, membershipId: membership.membershipId }),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(model.streamText).toHaveBeenCalledTimes(1);

		const call = model.streamText.mock.calls[0][0] as Parameters<typeof streamText>[0];
		expect(call.system).toContain("UNSAVED_GUIDANCE_275");
		expect(call.system).not.toContain("ROOT_GUIDANCE_271");
		expect(call.system).not.toContain("NESTED_GUIDANCE_272");
		expect(call.system).toContain("CATALOG_DESCRIPTION_273");
		expect(call.system).not.toContain("SECRET_SKILL_BODY_274");
		expect(call.tools).not.toHaveProperty("load_skill");
		expect(call.tools).not.toHaveProperty("read_skill_resource");
		expect(call.tools).not.toHaveProperty("run_skill_script");
		if (!call.prepareStep || !call.tools?.bash?.execute) throw new Error("Expected Bash and prepareStep");

		await t.run(async () => {
			const first = await call.prepareStep!({ model: call.model, messages: call.messages ?? [], steps: [], stepNumber: 0, experimental_context: call.experimental_context });
			expect(first).toBeUndefined();

			const output = await call.tools!.bash.execute!({ command: "cat .agents/skills/summarize-invoices/SKILL.md" }, { toolCallId: "read-skill", messages: [] });
			expect(output).toMatchObject({ output: expect.stringContaining("SECRET_SKILL_BODY_274") });
			expect(JSON.stringify(output)).not.toContain("NESTED_GUIDANCE_272");

			const listing = await call.tools!.bash.execute!({ command: "ls invoices" }, { toolCallId: "inspect-folder", messages: [] });
			expect(listing).toMatchObject({ instructions: expect.stringContaining("NESTED_GUIDANCE_272") });
			expect(JSON.stringify(listing)).not.toContain("UNSAVED_GUIDANCE_275");

			const second = await call.prepareStep!({ model: call.model, messages: call.messages ?? [], steps: [], stepNumber: 1, experimental_context: call.experimental_context });
			expect(second).toBeUndefined();

			const final = await call.prepareStep!({ model: call.model, messages: call.messages ?? [], steps: [], stepNumber: 9, experimental_context: call.experimental_context });
			expect(final?.activeTools).toEqual([]);
			expect(final?.system).toContain("last step");
		});
	});

	test("discovers skill metadata without loading its body or storing a selection", async () => {
		const { t, asUser, membership, threadId } = await setup();
		const { organizationId, workspaceId, userId } = membership;
		const skill = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId, workspaceId, userId, path: "/.agents/skills/check-list/SKILL.md",
			textContent: "---\nname: check-list\ndescription: Check a list\n---\n\nEXPLICIT_BODY_276",
		});
		if (skill._nay) throw new Error(skill._nay.message);

		const response = await asUser.fetch("/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ id: "selected-message", role: "user", parts: [{ type: "text", text: "Use this skill." }] }],
				parentId: null, mode: "ask", model: "gpt-5.4-nano", trigger: "submit-message", threadId, membershipId: membership.membershipId }),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(model.streamText.mock.calls[0][0].system).toContain("/.agents/skills/check-list/SKILL.md");
		expect(model.streamText.mock.calls[0][0].system).not.toContain("EXPLICIT_BODY_276");

		const messages = await t.run(ctx => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
		const stored = messages.find(message => message.clientGeneratedMessageId === "selected-message")!;
		expect(stored.content.metadata ?? {}).not.toHaveProperty("skillIds");
		expect(JSON.stringify(messages)).not.toContain("EXPLICIT_BODY_276");
	});

	test("keeps completed old skill results as ordinary stored history", async () => {
		const { t, asUser, membership, threadId } = await setup();
		const safe = {
			id: "stored-skill", role: "assistant", parts: [{ type: "tool-load_skill", toolCallId: "load", state: "output-available",
				input: { skillId: "a".repeat(32) }, output: { skillId: "a".repeat(32), version: "b".repeat(64), status: "loaded" } }],
		};

		const accepted = await asUser.mutation(api.ai_chat.thread_messages_add, { membershipId: membership.membershipId, threadId, parentId: null, messages: [{ clientGeneratedMessageId: "safe", content: safe }] });
		expect(accepted._nay).toBeUndefined();

		const withBody = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: membership.membershipId, threadId, parentId: null,
			messages: [{ clientGeneratedMessageId: "with-body", content: { ...safe, parts: [{ ...safe.parts[0], output: { ...safe.parts[0].output, body: "HISTORICAL_SKILL_BODY" } }] } }],
		});
		if (withBody._nay) throw new Error(withBody._nay.message);

		const docs = await t.run(ctx => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
		expect(docs.map(doc => doc.clientGeneratedMessageId)).toEqual(["safe", "with-body"]);
		expect(JSON.stringify(docs)).toContain("HISTORICAL_SKILL_BODY");

		const response = await asUser.fetch("/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ id: "followup", role: "user", parts: [{ type: "text", text: "Continue." }] }],
				parentId: withBody._yay.ids[0], mode: "ask", model: "gpt-5.4-nano", trigger: "submit-message", threadId, membershipId: membership.membershipId }),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(JSON.stringify(model.streamText.mock.calls[0][0].messages)).toContain("HISTORICAL_SKILL_BODY");
	});
});
