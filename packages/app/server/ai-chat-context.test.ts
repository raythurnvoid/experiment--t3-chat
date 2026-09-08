import { simulateReadableStream, stepCountIs, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Result } from "common/errors-as-values-utils.ts";
import { getFunctionName, type FunctionArgs, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import type { ai_chat_context_SavedSource } from "../convex/ai_chat_context.ts";
import { ai_chat_skills_LIMITS } from "../shared/ai-chat-skills.ts";
import {
	ai_chat_context_create,
	ai_chat_context_load_skill,
	ai_chat_context_prepare_step,
	ai_chat_context_system,
} from "./ai-chat-context.ts";
import {
	ai_chat_skill_tool_output_schema,
	ai_chat_tool_create_load_skill,
	ai_chat_tool_create_read_skill_resource,
	ai_chat_tool_create_run_skill_script,
} from "./server-ai-tools.ts";

const scope = {
	membershipId: "membership_1" as Id<"organizations_workspaces_users">,
	userId: "user_1" as Id<"users">,
};
const ctxData = {
	organizationId: "organization_1" as Id<"organizations">,
	workspaceId: "workspace_1" as Id<"organizations_workspaces">,
	organizationName: "personal",
	workspaceName: "home",
	userId: scope.userId,
};
const skillBody = "PRIVATE_SKILL_BODY";
const resourceBody = "PRIVATE_RESOURCE_BODY";
const scriptBody = "// Saved bytes: 🐵\r\nreturn { total: input.count + 2 };\r\n";
const runnerResult = {
	executionId: "execution_1",
	status: "succeeded",
	codeHash: "runner_code_hash",
	elapsedMs: 4,
	result: { total: 4, private: "PRIVATE_SCRIPT_RESULT" },
	resultTruncated: false,
	logs: ["PRIVATE_SCRIPT_LOG"],
	logsTruncated: false,
	error: null,
};

beforeEach(() => {
	vi.stubEnv("CODE_EXECUTION_RUNNER_URL", "https://runner.test");
	vi.stubEnv("CODE_EXECUTION_RUNNER_SECRET", "test-secret");
	vi.stubEnv("VITE_CONVEX_HTTP_URL", "https://app.test");
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json(runnerResult)));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function fixture(args: { body?: string; runtime?: string | null; scriptPath?: string } = {}) {
	const records = new Map<string, { source: ai_chat_context_SavedSource; content: string; readable: boolean }>();
	function addSource(path: string, content: string) {
		const nodeId = `source_${records.size + 1}` as Id<"files_nodes">;
		const record = {
			source: { nodeId, path, version: "a".repeat(64), size: new TextEncoder().encode(content).byteLength, status: "ready" as const },
			content,
			readable: true,
		};
		records.set(nodeId, record);
		return record;
	}
	function addSkill(name: string, body: string, runtime: string | null = "worker-async-body-v1") {
		return addSource(`/.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Catalog description for ${name}\n${runtime === null ? "" : `metadata:\n  bonobo-script-runtime: ${runtime}\n`}---\n${body}`);
	}
	const skill = addSkill("example", args.body ?? skillBody, args.runtime === undefined ? "worker-async-body-v1" : args.runtime);
	const resource = addSource("/.agents/skills/example/references/details.md", resourceBody);
	const script = addSource(args.scriptPath ?? "/.agents/skills/example/scripts/total.js", scriptBody);
	const runQuery = vi.fn(async (
		ref: FunctionReference<"query">,
		queryArgs: typeof scope & { sources?: { nodeId: Id<"files_nodes">; version: string }[]; skillId?: Id<"files_nodes">; version?: string },
	) => {
		expect(queryArgs).toMatchObject(scope);
		switch (getFunctionName(ref)) {
			case "ai_chat_context:discover_sources": {
				const sources = [...records.values()].filter((record) => record.readable).map((record) => ({ ...record.source }));
				return Result({ _yay: {
					instructions: sources.filter((source) => source.path.endsWith("/AGENTS.md"))
						.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path)),
					skills: sources.filter((source) => source.path.endsWith("/SKILL.md")),
				} });
			}
			case "ai_chat_context:check_sources":
				return Result({ _yay: (queryArgs.sources ?? []).flatMap(({ nodeId }) => {
					const record = records.get(nodeId);
					return record?.readable ? [record.source] : [];
				}) });
			case "ai_chat_context:get_skill_resources": {
				const record = records.get(queryArgs.skillId ?? "");
				if (!record?.readable) return Result({ _nay: { name: "unavailable", message: "Source unavailable." } });
				if (record.source.version !== queryArgs.version) return Result({ _nay: { name: "changed", message: "Source changed." } });
				const root = record.source.path.slice(0, -"SKILL.md".length);
				const resources = [...records.values()].filter((item) => item.readable && item !== record && item.source.path.startsWith(root));
				return Result({ _yay: resources.map((item) => ({ ...item.source })) });
			}
			default:
				throw new Error(`Unexpected query: ${getFunctionName(ref)}`);
		}
	});
	const runAction = vi.fn(async (
		ref: FunctionReference<"action">,
		readArgs: FunctionArgs<typeof internal.ai_chat_context.read_source>,
	) => {
		expect(getFunctionName(ref)).toBe("ai_chat_context:read_source");
		expect(readArgs).toMatchObject(scope);
		const record = records.get(readArgs.nodeId);
		if (!record?.readable) return Result({ _nay: { name: "unavailable", message: "Source unavailable." } });
		if (record.source.version !== readArgs.version) return Result({ _nay: { name: "changed", message: "Source changed." } });
		if (new TextEncoder().encode(record.content).byteLength > readArgs.maxBytes) return Result({ _nay: { name: "too_large", message: "Source too large." } });
		return Result({ _yay: { source: { ...record.source }, content: record.content } });
	});
	const runMutation = vi.fn(async () => null);
	// These request-local tests mock the saved-source boundary. Its DB access checks have their own suite.
	const ctx = { runQuery, runAction, runMutation } as unknown as ActionCtx;
	async function create() {
		for (const record of records.values()) record.source.size = new TextEncoder().encode(record.content).byteLength;
		const result = await ai_chat_context_create(ctx, scope);
		if (result._nay) throw new Error(result._nay.message);
		return result._yay;
	}
	return {
		ctx, create, records, addSource, addSkill, skill, resource, script, runQuery, runAction, runMutation,
		load: ai_chat_tool_create_load_skill(ctx).execute!,
		read: ai_chat_tool_create_read_skill_resource(ctx).execute!,
		run: ai_chat_tool_create_run_skill_script(ctx, ctxData).execute!,
	};
}

describe("ai_chat_context_create", () => {
	test("labels unsupported scripts without blocking the skill instructions", async () => {
		const f = fixture({ runtime: "node" });
		const context = await f.create();
		expect(context.catalog[0]).toMatchObject({ status: "available", scriptStatus: "unsupported" });
		expect(ai_chat_context_system(context, "base")).toContain('"scriptStatus":"unsupported"');
		expect((await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId))._nay).toBeUndefined();
		expect((await ai_chat_context_prepare_step(f.ctx, context, "base")).system).toContain(skillBody);
	});

	test("keeps two concurrent request contexts isolated", async () => {
		const f = fixture();
		const [first, second] = await Promise.all([f.create(), f.create()]);
		const firstOptions = { toolCallId: "first", messages: [], experimental_context: first };
		const secondOptions = { toolCallId: "second", messages: [], experimental_context: second };
		expect(ai_chat_context_system(first, "base")).not.toContain(skillBody);
		await f.load({ skillId: f.skill.source.nodeId }, firstOptions);
		const [firstStep, secondStep] = await Promise.all([
			ai_chat_context_prepare_step(f.ctx, first, "base"),
			ai_chat_context_prepare_step(f.ctx, second, "base"),
		]);
		expect(firstStep.system).toContain(skillBody);
		expect(secondStep.system).not.toContain(skillBody);
		expect(firstStep.experimental_context).toBe(first);
		expect(secondStep.experimental_context).toBe(second);
		expect(await f.read({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId }, secondOptions)).toEqual({
			skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId, status: "not_loaded",
		});
		expect(second.loaded.size).toBe(0);
	});

	test("puts an explicitly selected skill only in its prepared system context", async () => {
		const f = fixture();
		const context = await f.create();
		expect(ai_chat_context_system(context, "base")).toContain("Catalog description for example");
		expect(ai_chat_context_system(context, "base")).not.toContain(skillBody);
		expect(await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId)).toEqual({ _yay: { version: f.skill.source.version } });
		const prepared = await ai_chat_context_prepare_step(f.ctx, context, "base");
		expect(prepared.system).toContain(skillBody);
		expect(prepared.experimental_context).toBe(context);
		expect(prepared.system).not.toContain(resourceBody);
		expect(prepared.system).not.toContain(scriptBody);
	});
});

describe("ai_chat_tool_create_load_skill", () => {
	test("refuses parallel read and run calls until the loaded body was delivered", async () => {
		const f = fixture();
		const context = await f.create();
		const options = { toolCallId: "parallel", messages: [], experimental_context: context };
		const input = { skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId };
		f.runAction.mockClear();
		const [loaded, read, run] = await Promise.all([f.load({ skillId: input.skillId }, options), f.read(input, options), f.run(input, options)]);
		expect(loaded).toEqual({ skillId: input.skillId, version: f.skill.source.version, status: "loaded" });
		expect(read).toEqual({ ...input, status: "not_loaded" });
		expect(run).toEqual({ ...input, status: "not_loaded" });
		// A later tool call in the same step is still too early.
		expect(await f.run(input, options)).toEqual({ ...input, status: "not_loaded" });
		expect(f.runAction).toHaveBeenCalledTimes(1);
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("refuses a changed source before activation", async () => {
		const f = fixture();
		const context = await f.create();
		f.skill.source = { ...f.skill.source, version: "b".repeat(64) };
		f.skill.content = f.skill.content.replace(skillBody, "NEW_PRIVATE_BODY");
		const output = await f.load({ skillId: f.skill.source.nodeId }, { toolCallId: "changed", messages: [], experimental_context: context });
		expect(output).toEqual({ skillId: f.skill.source.nodeId, status: "changed" });
		expect(context.loaded.size).toBe(0);
		expect(ai_chat_context_system(context, "base")).not.toContain("NEW_PRIVATE_BODY");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("refuses loading a skill when its body would exceed active bytes", async () => {
		const f = fixture({ body: "S".repeat(1000) });
		for (let index = 0; index < 4; index++) f.addSource(`/folder-${index}/AGENTS.md`, "I".repeat(16_300));
		const context = await f.create();
		expect((await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId))._nay?.name).toBe("too_large");
		expect(context.loaded.size).toBe(0);
	});

	test("refuses more than 1,000 pinned resources across activated skills", async () => {
		const f = fixture();
		f.records.clear();
		const skills = [];
		for (let index = 0; index < 6; index++) {
			const skill = f.addSkill(`skill-${index}`, "Body");
			skills.push(skill);
			for (let resource = 0; resource < ai_chat_skills_LIMITS.resourcesPerSkill; resource++) {
				f.addSource(`/.agents/skills/skill-${index}/references/${resource}.md`, "Resource");
			}
		}
		const context = await f.create();
		for (const skill of skills.slice(0, 5)) expect((await ai_chat_context_load_skill(f.ctx, context, skill.source.nodeId))._nay).toBeUndefined();
		expect((await ai_chat_context_load_skill(f.ctx, context, skills[5].source.nodeId))._nay?.name).toBe("too_large");
		expect(context.loaded.size).toBe(5);
		expect([...context.loaded.values()].reduce((sum, skill) => sum + skill.resources.length, 0)).toBe(1000);
	});
});

describe("ai_chat_tool_create_read_skill_resource", () => {
	test("refuses a readable resource ID from another skill before any runner side effect", async () => {
		const f = fixture();
		f.addSkill("another", "Other saved instructions");
		const outside = f.addSource("/.agents/skills/another/scripts/other.js", "return 9;");
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		f.runAction.mockClear();
		const input = { skillId: f.skill.source.nodeId, resourceId: outside.source.nodeId };
		const options = { toolCallId: "wrong-bundle", messages: [], experimental_context: context };
		expect(await f.read(input, options)).toEqual({ ...input, status: "unavailable" });
		expect(await f.run(input, options)).toEqual({ ...input, status: "unavailable" });
		expect(f.runAction).not.toHaveBeenCalled();
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("delivers resource text in the next system override and returns only references", async () => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		const before = await ai_chat_context_prepare_step(f.ctx, context, "base");
		const output = await f.read({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId }, { toolCallId: "read", messages: [], experimental_context: context });
		expect(output).toEqual({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId, version: f.resource.source.version, status: "read" });
		expect(ai_chat_skill_tool_output_schema.safeParse(output).success).toBe(true);
		expect(before.system).not.toContain(resourceBody);
		expect((await ai_chat_context_prepare_step(f.ctx, context, "base")).system).toContain(resourceBody);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("counts UTF-8 resource bytes without counting a repeated read twice", async () => {
		const f = fixture();
		f.resource.content = "🐵".repeat(15_000);
		f.script.content = "🐵".repeat(2000);
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		const options = { toolCallId: "bytes", messages: [], experimental_context: context };
		const input = { skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId };
		expect(await f.read(input, options)).toMatchObject({ status: "read" });
		expect(await f.read(input, options)).toMatchObject({ status: "read" });
		const tooLarge = f.addSource("/.agents/skills/example/references/extra.md", "🐵".repeat(2000));
		// The manifest is fixed at activation, so newly added resources stay unavailable.
		expect(await f.read({ ...input, resourceId: tooLarge.source.nodeId }, options)).toMatchObject({ status: "unavailable" });
		expect(await f.read({ ...input, resourceId: f.script.source.nodeId }, options)).toMatchObject({ status: "too_large" });
		expect(context.loaded.get(input.skillId)?.resourceText.size).toBe(1);
	});

	test.each(["skill", "script"] as const)("refuses a newly revoked %s before granting runner access", async (revoked) => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		f[revoked].readable = false;
		const options = { toolCallId: "access-lost", messages: [], experimental_context: context };
		const input = { skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId };
		expect(await f.read(input, options)).toEqual({ ...input, status: "unavailable" });
		expect(await f.run(input, options)).toEqual({ ...input, status: "unavailable" });
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each(["saved edit", "rename out of the bundle"])("refuses a pinned resource after a %s before any run side effect", async (change) => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		f.script.source = { ...f.script.source, version: "b".repeat(64), ...(change === "rename out of the bundle" ? { path: "/.agents/skills/another/scripts/total.js" } : {}) };
		const options = { toolCallId: "changed-resource", messages: [], experimental_context: context };
		const input = { skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId };
		expect(await f.read(input, options)).toEqual({ ...input, status: "changed" });
		expect(await f.run(input, options)).toEqual({ ...input, status: "changed" });
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("keeps the loaded body and unchanged resource pins after a saved skill edit", async () => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		f.skill.source = { ...f.skill.source, version: "b".repeat(64) };
		f.skill.content = f.skill.content.replace(skillBody, "NEXT_TURN_BODY");
		expect(await f.read({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId }, { toolCallId: "pinned", messages: [], experimental_context: context })).toMatchObject({ status: "read" });
		const prepared = await ai_chat_context_prepare_step(f.ctx, context, "base");
		expect(prepared.system).toContain(skillBody);
		expect(prepared.system).not.toContain("NEXT_TURN_BODY");
	});
});

describe("ai_chat_context_prepare_step", () => {
	test.each(["selected", "model-loaded"])("delivers a %s skill's resources and script results to the next real SDK model prompt", async (activation) => {
		const f = fixture();
		const context = await f.create();
		if (activation === "selected") await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		const calls = [
			...(activation === "selected" ? [] : [{ toolName: "load_skill", toolCallId: "load", input: { skillId: f.skill.source.nodeId } }]),
			{ toolName: "read_skill_resource", toolCallId: "read", input: { skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId } },
			{ toolName: "run_skill_script", toolCallId: "run", input: { skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, input: { count: 2 } } },
		];
		const model: MockLanguageModelV3 = new MockLanguageModelV3({
			doStream: async () => {
				const next = calls[model.doStreamCalls.length - 1];
				return { stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						...(next ? [{ type: "tool-call" as const, ...next, input: JSON.stringify(next.input) }] : [
							{ type: "text-start" as const, id: "answer" },
							{ type: "text-delta" as const, id: "answer", delta: "Final result: 4" },
							{ type: "text-end" as const, id: "answer" },
						]),
						{
							type: "finish" as const,
							finishReason: { unified: next ? "tool-calls" as const : "stop" as const, raw: undefined },
							usage: {
								inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
								outputTokens: { total: 1, text: 1, reasoning: undefined },
							},
						},
					],
				}) };
			},
		});
		const result = streamText({
			model,
			system: ai_chat_context_system(context, "base"),
			experimental_context: context,
			prepareStep: ({ experimental_context }) => {
				expect(experimental_context).toBe(context);
				return ai_chat_context_prepare_step(f.ctx, experimental_context as typeof context, "base");
			},
			prompt: "Read the skill reference and run its saved script with count 2.",
			tools: {
				load_skill: ai_chat_tool_create_load_skill(f.ctx),
				read_skill_resource: ai_chat_tool_create_read_skill_resource(f.ctx),
				run_skill_script: ai_chat_tool_create_run_skill_script(f.ctx, ctxData),
			},
			stopWhen: stepCountIs(5),
			maxRetries: 0,
		});
		await result.consumeStream();
		expect(await result.text).toBe("Final result: 4");
		expect(model.doStreamCalls).toHaveLength(calls.length + 1);
		const systems = model.doStreamCalls.map(({ prompt }) => prompt.find((message) => message.role === "system")?.content);
		const readStep = activation === "selected" ? 0 : 1;
		expect(systems[0]).not.toContain(resourceBody);
		expect(systems[0]).not.toContain("PRIVATE_SCRIPT_RESULT");
		if (activation === "selected") expect(systems[0]).toContain(skillBody);
		else expect(systems[0]).not.toContain(skillBody);
		expect(systems[readStep]).toContain(skillBody);
		expect(systems[readStep]).not.toContain(resourceBody);
		expect(systems[readStep + 1]).toContain(resourceBody);
		expect(systems[readStep + 1]).not.toContain("PRIVATE_SCRIPT_RESULT");
		expect(systems[readStep + 2]).toContain("PRIVATE_SCRIPT_RESULT");
		expect(systems[readStep + 2]).toContain("PRIVATE_SCRIPT_LOG");
		expect(systems[readStep + 2]).toContain('"toolCallId":"run"');
		for (const { prompt } of model.doStreamCalls) {
			// Tool messages must stay safe even though the system now holds private source text.
			expect(JSON.stringify(prompt.filter((message) => message.role !== "system"))).not.toContain("PRIVATE_");
		}
		const outputs = (await result.steps).flatMap((step) => step.toolResults.map((toolResult) => toolResult.output));
		expect(outputs.map((output) => ai_chat_skill_tool_output_schema.parse(output).status)).toEqual(activation === "selected" ? ["read", "completed"] : ["loaded", "read", "completed"]);
		for (const output of outputs) expect(ai_chat_skill_tool_output_schema.safeParse(output).success).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test.each(["skill", "resource"] as const)("removes revoked %s text and derived script results before the next step", async (revoked) => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		const options = { toolCallId: "revoke", messages: [], experimental_context: context };
		await f.read({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId }, options);
		await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId }, options);
		const delivered = await ai_chat_context_prepare_step(f.ctx, context, "base");
		expect(delivered.system).toContain(resourceBody);
		expect(delivered.system).toContain("PRIVATE_SCRIPT_RESULT");
		f[revoked].readable = false;
		const prepared = await ai_chat_context_prepare_step(f.ctx, context, "base");
		expect(prepared.system).not.toContain(resourceBody);
		expect(prepared.system).not.toContain("PRIVATE_SCRIPT_RESULT");
		expect(prepared.system).not.toContain("PRIVATE_SCRIPT_LOG");
		if (revoked === "skill") expect(prepared.system).not.toContain(skillBody);
		else expect(prepared.system).toContain(skillBody);
		vi.mocked(fetch).mockClear();
		f.runMutation.mockClear();
		expect(await f.read({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId }, options)).toMatchObject({ status: revoked === "skill" ? "not_loaded" : "unavailable" });
		if (revoked === "skill") expect(await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId }, options)).toMatchObject({ status: "not_loaded" });
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("ai_chat_tool_create_run_skill_script", () => {
	test.each([
		{ runtime: null, scriptPath: "/.agents/skills/example/scripts/total.js" },
		{ runtime: "node", scriptPath: "/.agents/skills/example/scripts/total.js" },
		{ runtime: "worker-async-body-v1", scriptPath: "/.agents/skills/example/scripts/total.py" },
	])("refuses unsupported runtime $runtime for $scriptPath before reading or running", async (args) => {
		const f = fixture(args);
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		f.runAction.mockClear();
		expect(await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId }, { toolCallId: "unsupported", messages: [], experimental_context: context })).toMatchObject({ status: "unsupported_runtime" });
		expect(f.runAction).not.toHaveBeenCalled();
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("sends exact saved script bytes without public network and keeps results in the next system only", async () => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		const before = await ai_chat_context_prepare_step(f.ctx, context, "base");
		const output = await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, input: { count: 2 } }, { toolCallId: "run", messages: [], experimental_context: context });
		expect(output).toEqual({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, version: f.script.source.version, status: "completed" });
		expect(ai_chat_skill_tool_output_schema.safeParse(output).success).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, request] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe("https://runner.test/internal/execute-code");
		const body: unknown = JSON.parse(String(request?.body));
		expect(body).toMatchObject({ code: scriptBody, input: { count: 2 }, app: { origin: "https://app.test" } });
		expect(body).not.toHaveProperty("network");
		expect(f.runMutation).toHaveBeenCalledWith(internal.public_api.create_grant, expect.objectContaining({ scopes: ["files:list", "files:read"], userId: scope.userId }));
		expect(before.system).not.toContain("PRIVATE_SCRIPT_RESULT");
		const prepared = await ai_chat_context_prepare_step(f.ctx, context, "base");
		expect(prepared.system).toContain("PRIVATE_SCRIPT_RESULT");
		expect(prepared.system).toContain("PRIVATE_SCRIPT_LOG");
		expect(prepared.system).not.toContain(scriptBody);
	});

	test("matches parallel script results to their calls when the second call finishes first", async () => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		const completions: ((response: Response) => void)[] = [];
		vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
		const first = f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, input: { count: 1 } }, { toolCallId: "first", messages: [], experimental_context: context });
		const second = f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, input: { count: 2 } }, { toolCallId: "second", messages: [], experimental_context: context });
		await vi.waitFor(() => expect(completions).toHaveLength(2));
		completions[1](Response.json({ ...runnerResult, result: "SECOND_RESULT" }));
		expect(await second).toMatchObject({ status: "completed" });
		completions[0](Response.json({ ...runnerResult, result: "FIRST_RESULT" }));
		expect(await first).toMatchObject({ status: "completed" });
		const prepared = await ai_chat_context_prepare_step(f.ctx, context, "base");
		expect(JSON.parse(prepared.system.split("\n\n").at(-1)!)).toMatchObject({ scriptResults: [
			{ toolCallId: "second", resourceId: f.script.source.nodeId, text: expect.stringContaining("SECOND_RESULT") },
			{ toolCallId: "first", resourceId: f.script.source.nodeId, text: expect.stringContaining("FIRST_RESULT") },
		] });
	});

	test.each(["script bytes", "input bytes"])("refuses excessive %s before issuing a grant or fetch", async (limit) => {
		const f = fixture();
		if (limit === "script bytes") f.script.content = "🐵".repeat(5001);
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		const output = await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, ...(limit === "input bytes" ? { input: "🐵".repeat(8000) } : {}) }, { toolCallId: "limits", messages: [], experimental_context: context });
		expect(output).toMatchObject({ status: limit === "script bytes" ? "too_large" : "failed" });
		expect(ai_chat_skill_tool_output_schema.safeParse(output).success).toBe(true);
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each(["http", "network", "malformed JSON", "invalid shape", "script error"])("returns only safe status for a runner %s failure", async (failure) => {
		const f = fixture();
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		vi.mocked(fetch).mockImplementation(async () => {
			if (failure === "network") throw new Error("PRIVATE_NETWORK_ERROR");
			if (failure === "http") return Response.json({ error: { message: "PRIVATE_HTTP_ERROR" } }, { status: 500 });
			if (failure === "malformed JSON") return new Response("PRIVATE_INVALID_JSON");
			if (failure === "invalid shape") return Response.json({ private: "PRIVATE_INVALID_SHAPE" });
			return Response.json({ ...runnerResult, status: "errored", error: { name: "Error", message: "PRIVATE_SCRIPT_ERROR" } });
		});
		const output = await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId }, { toolCallId: "failed-run", messages: [], experimental_context: context });
		expect(output).toMatchObject({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId, status: "failed" });
		expect(ai_chat_skill_tool_output_schema.safeParse(output).success).toBe(true);
		expect(JSON.stringify(output)).not.toContain("PRIVATE_");
		const prepared = await ai_chat_context_prepare_step(f.ctx, context, "base");
		if (failure === "malformed JSON" || failure === "invalid shape") {
			expect(prepared.system).toContain("Code execution returned an invalid response.");
			expect(prepared.system).not.toContain("PRIVATE_INVALID_");
		} else expect(prepared.system).toContain(failure === "script error" ? "PRIVATE_SCRIPT_ERROR" : `PRIVATE_${failure.toUpperCase()}_ERROR`);
	});

	test("does not grow active context when repeated script results exceed its byte cap", async () => {
		const f = fixture({ body: "S" });
		f.resource.content = "R".repeat(ai_chat_skills_LIMITS.active - 1);
		const context = await f.create();
		await ai_chat_context_load_skill(f.ctx, context, f.skill.source.nodeId);
		await ai_chat_context_prepare_step(f.ctx, context, "base");
		const options = { toolCallId: "full-context", messages: [], experimental_context: context };
		expect(await f.read({ skillId: f.skill.source.nodeId, resourceId: f.resource.source.nodeId }, options)).toMatchObject({ status: "read" });
		const before = (await ai_chat_context_prepare_step(f.ctx, context, "base")).system;
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(await f.run({ skillId: f.skill.source.nodeId, resourceId: f.script.source.nodeId }, options)).toMatchObject({ status: "too_large" });
		}
		expect((await ai_chat_context_prepare_step(f.ctx, context, "base")).system).toBe(before);
	});
});
