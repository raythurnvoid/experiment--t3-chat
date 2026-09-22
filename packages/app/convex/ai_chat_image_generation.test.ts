import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import type { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
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
					controller.close();
				},
			}),
		response: Promise.resolve({ messages: [] }),
		consumeStream: async () => {},
	}));
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_images" as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/${key}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubEnv("OPENAI_API_KEY", "image-test");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function setup(viewer = false) {
	const t = test_convex();
	const personal = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	let team = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			userId: viewer ? undefined : personal.userId,
			organizationName: "image-team",
			workspaceName: "home",
		}),
	);
	if (viewer) {
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: team.userId });
		expect(
			await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: team.organizationId,
				workspaceId: team.workspaceId,
				userIdToAdd: personal.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await owner.mutation(api.access_control.set_user_role, {
				organizationId: team.organizationId,
				workspaceId: team.workspaceId,
				userId: personal.userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", team.workspaceId).eq("userId", personal.userId).eq("active", true),
				)
				.first(),
		);
		if (!membership) throw new Error("Expected team viewer");
		team = { ...team, userId: personal.userId, membershipId: membership._id };
	}
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: team.userId });
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: team.membershipId,
		clientGeneratedId: "image-route",
		title: "Images",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const threadId = created._yay.threadId;
	const response = await asUser.fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: [{ id: "request", role: "user", parts: [{ type: "text", text: "Draw an image." }] }],
			parentId: null,
			mode: "agent",
			model: "gpt-5.4-nano",
			trigger: "submit-message",
			threadId,
			membershipId: team.membershipId,
		}),
	});
	expect(response.status, await response.text()).toBe(200);
	const call = model.streamText.mock.calls[0]![0] as Parameters<typeof streamText>[0];
	if (!call.prepareStep || !call.tools?.prepare_image_generation?.execute)
		throw new Error("Expected image preparation");
	const prepareStep = call.prepareStep;
	async function prepare(choices: Array<Array<"current" | "personal">>, stepNumber = choices.length) {
		const steps: Array<{ toolResults: Array<{ toolName: string; output: unknown }> }> = [];
		for (const [index, workspaces] of choices.entries()) {
			const toolResults = [];
			for (const workspace of workspaces) {
				const output = await call.tools!.prepare_image_generation!.execute!(
					{ workspace },
					{ toolCallId: `prepare-${index}-${workspace}`, messages: [] },
				);
				toolResults.push({ toolName: "prepare_image_generation", output });
			}
			steps.push({ toolResults });
		}
		let selected: Awaited<ReturnType<typeof prepareStep>>;
		await t.run(async () => {
			selected = await prepareStep({
				model: call.model,
				messages: call.messages ?? [],
				stepNumber,
				// Only completed tool results select the next step; these are real preparation outputs.
				steps: steps as Parameters<typeof prepareStep>[0]["steps"],
				experimental_context: call.experimental_context,
			});
		});
		return selected;
	}
	return { t, asUser, personal, team, threadId, call, prepare };
}

describe("image destination steps", () => {
	test.each(["current", "personal"] as const)("generates only after one %s preparation", async (workspace) => {
		const f = await setup();
		expect(f.call.activeTools).toContain("prepare_image_generation");
		expect(f.call.activeTools).not.toContain("image_generation");
		const selected = await f.prepare([[workspace]]);
		expect(selected).toMatchObject({
			activeTools: ["image_generation"],
			toolChoice: { type: "tool", toolName: "image_generation" },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
	});

	test("rejects conflicting choices and never reuses an older step", async () => {
		const f = await setup();
		const conflict = await f.prepare([["current", "personal"]]);
		expect(conflict?.activeTools).not.toContain("image_generation");
		expect(conflict?.system).toContain("choose exactly one workspace");
		const old = await f.prepare([["personal"], []]);
		expect(old?.activeTools).not.toContain("image_generation");
		expect((await f.prepare([]))?.activeTools).not.toContain("image_generation");
	});

	test("leaves the last step for a reply and does not offer late preparation", async () => {
		const f = await setup();
		expect((await f.prepare([], 8))?.activeTools).not.toContain("prepare_image_generation");
		expect((await f.prepare([["personal"]], 8))?.activeTools).toEqual(["image_generation"]);
		expect((await f.prepare([["personal"]], 9))?.activeTools).toEqual([]);
	});

	test("checks source access again before sending an image request", async () => {
		const f = await setup();
		await f.asUser.mutation(api.ai_chat.thread_archive, { membershipId: f.team.membershipId, threadId: f.threadId });
		await expect(f.prepare([["personal"]])).rejects.toThrow("Chat is no longer available");
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("a team viewer can generate in home but not in the team", async () => {
		const f = await setup(true);
		expect((await f.prepare([["personal"]]))?.activeTools).toEqual(["image_generation"]);
		await expect(f.prepare([["current"]])).rejects.toThrow("Permission denied");
		expect(await f.t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toEqual([]);
	});

	test("checks the output folder policy before generation", async () => {
		const f = await setup();
		const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.personal.membershipId,
			parentId: files_ROOT_ID,
			path: "/generated",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		expect(
			await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.personal.membershipId,
				nodeId: folder._yay.nodeId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });
		await expect(f.prepare([["personal"]])).rejects.toThrow("read-only");
		expect((await f.prepare([["current"]]))?.activeTools).toEqual(["image_generation"]);
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("checks the destination payer's plan before generation", async () => {
		const f = await setup();
		await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: f.personal.userId, plan: "Free" }));
		await expect(f.prepare([["personal"]])).rejects.toThrow("This workspace's plan does not include file uploads");
		await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: f.personal.userId, plan: "Pro" }));
		expect((await f.prepare([["personal"]]))?.activeTools).toEqual(["image_generation"]);
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
	});

	test("binds delayed results to their generation step and saves each call once", async () => {
		const f = await setup();
		let imageId = "personal-image";
		const requests: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).startsWith("https://r2.test/")) return new Response(null);
				requests.push(JSON.parse(String(init?.body)));
				const events = [
					{ type: "response.output_item.added", output_index: 0, item: { type: "image_generation_call", id: imageId } },
					{
						type: "response.image_generation_call.partial_image",
						item_id: imageId,
						partial_image_b64: "preview",
						partial_image_index: 0,
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { type: "image_generation_call", id: imageId, result: "AQID" },
					},
					{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
				];
				return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}),
		);
		for (const workspace of ["personal", "current"] as const) {
			imageId = `${workspace}-image`;
			const selected = await f.prepare([[workspace]]);
			const selectedModel = selected?.model;
			if (!selectedModel || typeof selectedModel === "string" || selectedModel.specificationVersion !== "v3")
				throw new Error("Expected an image model");
			const streamed = await selectedModel.doStream({
				prompt: [{ role: "user", content: [{ type: "text", text: "Draw." }] }],
				tools: [{ type: "provider", id: "openai.image_generation", name: "image_generation", args: {} }],
				toolChoice: { type: "tool", toolName: "image_generation" },
			});
			const parts = await Array.fromAsync(streamed.stream);
			expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1);
			expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(1);
		}
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ tool_choice: { type: "image_generation" } });
		const convert = f.call.tools!.image_generation!.toModelOutput!;
		// Save in reverse order after both steps have run. Neither result may use the latest choice.
		for (const workspace of ["current", "personal"] as const) {
			const args = { toolCallId: `${workspace}-image`, input: {}, output: { result: "AQID" } };
			const saved = await f.t.run(async () => await convert(args));
			expect(JSON.stringify(saved)).toContain("succeeded");
			expect(await f.t.run(async () => await convert(args))).toEqual(saved);
		}
		const receipts = await f.t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect());
		expect(receipts).toHaveLength(2);
		expect(new Set(receipts.map((receipt) => receipt.workspaceId))).toEqual(
			new Set([f.team.workspaceId, f.personal.workspaceId]),
		);
		expect(receipts.every((receipt) => receipt.agentSource?.threadId === f.threadId)).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const missing = await f.t.run(
			async () => await convert({ toolCallId: "unbound", input: {}, output: { result: "AQID" } }),
		);
		expect(JSON.stringify(missing)).toContain("errored");
		expect(await f.t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toHaveLength(2);
	});
});
