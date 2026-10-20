import { globSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { ai_chat_skills_LIMITS, ai_chat_skills_parse } from "../server/ai-chat-skills.ts";

const skillRoot = fileURLToPath(new URL("../../../.agents/skills/press-api/", import.meta.url));
const schemaPath = fileURLToPath(new URL("../shared/api-schemas.ts", import.meta.url));

describe("Bonobo Senate API client skill", () => {
	test("loads valid metadata and readable resources without links outside its folder", () => {
		const entry = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
		expect(ai_chat_skills_parse(entry, "press-api")._yay?.name).toBe("press-api");
		const files = globSync("**/*.md", { cwd: skillRoot });
		const linked = new Set<string>();
		for (const file of files) {
			const text = readFileSync(path.join(skillRoot, file), "utf8");
			expect(Buffer.byteLength(text), file).toBeLessThanOrEqual(ai_chat_skills_LIMITS.skill);
			for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
				const target = match[1].split("#")[0];
				expect(target, `${file}: ${target}`).not.toMatch(/^(?:[a-z]+:|[/\\])/iu);
				const resolved = path.resolve(skillRoot, target);
				const relative = path.relative(skillRoot, resolved);
				expect(relative, `${file}: ${target}`).not.toMatch(/^\.\.(?:[/\\]|$)/u);
				expect(path.isAbsolute(relative), `${file}: ${target}`).toBe(false);
				expect(readFileSync(resolved, "utf8").length, `${file}: ${target}`).toBeGreaterThan(0);
				linked.add(relative);
			}
		}
		expect(files.filter((file) => file !== "SKILL.md" && !linked.has(file))).toEqual([]);
	});

	test("classifies every public route in the main schema exactly once", () => {
		// Read the explicit schema keys without loading the HTTP runtime or deployment environment.
		const source = ts.createSourceFile(schemaPath, readFileSync(schemaPath, "utf8"), ts.ScriptTarget.Latest, true);
		const schema = source.statements.find(
			(statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "api_schemas_Main",
		);
		if (!schema || !ts.isInterfaceDeclaration(schema)) throw new Error("The main API schema is missing");
		const routes = schema.members.flatMap((member) =>
			member.name && ts.isStringLiteral(member.name) && member.name.text.startsWith("/api/v1/")
				? [member.name.text]
				: [],
		);
		const index = readFileSync(path.join(skillRoot, "references/route-index.md"), "utf8");
		const rows = index.split("\n").filter((line) => line.startsWith("| `/api/v1/"));
		const documented = rows.map((line) => {
			const [, route, method, classification, callers, scope, extraAuth, guide] = line
				.split("|")
				.map((cell) => cell.trim());
			expect(method, route).toBe("POST");
			expect(["client", "app", "system"], route).toContain(classification);
			for (const cell of [callers, scope, extraAuth, guide]) expect(cell, route).toBeTruthy();
			return route.replaceAll("`", "");
		});
		expect(routes.length).toBeGreaterThan(0);
		expect(documented.toSorted()).toEqual(routes.toSorted());
	});

	test("the documented reader joins saved steps and keeps empty replies, metadata and raw parts", async () => {
		const guide = readFileSync(path.join(skillRoot, "references/ai-conversations.md"), "utf8");
		const code = /```js\n([\s\S]*?)\n```/u.exec(guide)?.[1];
		if (!code) throw new Error("The transcript recipe is missing");
		const read = new Function(`${code.replace("export ", "")}\nreturn readAiConversation;`)() as (args: {
			origin: string;
			key: string;
			threadId: string;
			fetcher: (url: URL, init: RequestInit) => Promise<Response>;
		}) => Promise<unknown>;
		const metadata = { selectedModeId: "ask" };
		const empty = {
			messageId: "empty",
			parentId: "reply",
			role: "assistant",
			status: "stopped",
			metadata,
		};
		const reply = { messageId: "reply", parentId: "user", role: "assistant", metadata };
		const user = { messageId: "user", parentId: null, role: "user", metadata };
		const first = [{ type: "text", text: "first" }];
		const last = [{ type: "tool-bash", output: { metadata: { output: { outputId: "stored" } } } }];
		const sent = [{ type: "data-file-quote", data: { fileNodeId: null, text: "saved quote" } }];
		const thread = { id: "thread", title: "Title", endMessageId: "empty" };
		const pages = [
			{ kind: "header", thread, cursor: "empty", isDone: false },
			{ kind: "fragment", fragment: { ...empty, stepIndex: null, stepStatus: null, parts: [] }, cursor: "last" },
			{ kind: "fragment", fragment: { ...reply, stepIndex: 1, stepStatus: "partial", parts: last }, cursor: "first" },
			{ kind: "fragment", fragment: { ...reply, stepIndex: 0, stepStatus: "done", parts: first }, cursor: "user" },
			{ kind: "fragment", fragment: { ...user, stepIndex: null, stepStatus: null, parts: sent }, isDone: true },
		];
		const cursors: unknown[] = [];
		const result = await read({
			origin: "https://api.example.test",
			key: "test-placeholder",
			threadId: "thread",
			fetcher: async (url, init) => {
				expect(url.pathname).toBe("/api/v1/ai-chat/threads/transcript");
				const body = JSON.parse(String(init.body)) as { threadId: string; cursor: unknown };
				expect(body.threadId).toBe("thread");
				cursors.push(body.cursor);
				return Response.json(pages[cursors.length - 1]);
			},
		});
		expect(cursors).toEqual([null, "empty", "last", "first", "user"]);
		expect(result).toEqual({
			thread,
			messages: [
				{ ...user, parts: sent, steps: [] },
				{
					...reply,
					parts: [...first, ...last],
					steps: [
						{ stepIndex: 0, stepStatus: "done", parts: first },
						{ stepIndex: 1, stepStatus: "partial", parts: last },
					],
				},
				{ ...empty, parts: [], steps: [] },
			],
		});
	});
});
