import { InMemoryFs, type CommandContext } from "just-bash/browser";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { bash_meta_command_create } from "./bash-meta-command.ts";
import {
	bash_EXTERNAL_MOUNTS_ROOT,
	bash_PLUGINS_MOUNT_ROOT,
	bash_DbFilesFs,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const currentWorkspacePath = "/home/cloud-usr/w/personal/home";
const ctxData = {
	organizationId: "organization_1" as Id<"organizations">,
	workspaceId: "workspace_1" as Id<"organizations_workspaces">,
	organizationName: "personal",
	workspaceName: "home",
	userId: "user_1" as Id<"users">,
	threadId: "thread_1" as Id<"ai_chat_threads">,
};

function create_command_runner() {
	// One generic response covers both queries `meta search` makes: the pending path
	// overlay read (empty = no pending moves) and the metadata search page.
	const runQuery = vi.fn(async (_ref: unknown, _args: unknown) => ({
		pendingUpdates: [],
		referencedNodes: [],
		items: [],
		continueCursor: "",
		isDone: true,
	}));
	const ctx = {
		runQuery,
		runMutation: vi.fn(),
		runAction: vi.fn(),
	} as unknown as ActionCtx;
	const appDbFilesFs = new bash_DbFilesFs({
		ctx,
		ctxData,
		currentWorkspacePath,
		allowDbFilesMkdir: false,
	});
	// `meta` runs against the app scope here; the mount maps are required by the dbFilesRoots shape
	// but stay empty for these app-path cases.
	const dbFilesRoots: bash_DbFilesRoots = {
		app: {
			currentWorkspacePath,
			fs: appDbFilesFs,
		},
		externalMounts: {
			currentWorkspacePath: bash_EXTERNAL_MOUNTS_ROOT,
			mounts: new Map(),
		},
		plugins: {
			currentWorkspacePath: bash_PLUGINS_MOUNT_ROOT,
			mounts: new Map(),
		},
	};
	const commandCtx = {
		fs: new InMemoryFs(),
		cwd: currentWorkspacePath,
		env: new Map(),
		stdin: "" as unknown as CommandContext["stdin"],
	} satisfies CommandContext;
	return {
		command: bash_meta_command_create(ctx, dbFilesRoots),
		commandCtx,
		runQuery,
	};
}

describe("bash_meta_command_create", () => {
	test("accepts one positive indexed predicate", async () => {
		const cases = [
			{
				where: '{"exists":"frontmatter.cc"}',
				plan: { op: "exists", qualifiedField: "frontmatter.cc" },
			},
			{
				where: '{"eq":["frontmatter.amount",120.5]}',
				plan: { op: "eq", qualifiedField: "frontmatter.amount", value: 120.5 },
			},
			{
				where: '{"prefix":["frontmatter.subject","Inv"]}',
				plan: { op: "prefix", qualifiedField: "frontmatter.subject", value: "Inv" },
			},
			{
				where: '{"range":["frontmatter.amount",{"gte":100,"lt":500}]}',
				plan: { op: "range", qualifiedField: "frontmatter.amount", gte: 100, lt: 500 },
			},
		];

		for (const item of cases) {
			const { command, commandCtx, runQuery } = create_command_runner();
			const result = await command.execute(["search", "--where", item.where], commandCtx);

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			// The overlay read runs first, so the metadata search is the last query.
			expect(runQuery.mock.calls.at(-1)?.[1]).toMatchObject({ plan: item.plan });
		}
	});

	test("rejects boolean, negative, unqualified, unknown-kind, and non-primitive filters", async () => {
		const cases = [
			{ where: '{"and":[{"exists":"frontmatter.cc"}]}', message: "one indexed field predicate" },
			{ where: '{"neq":["frontmatter.cc","bob"]}', message: "positive predicates" },
			{ where: '{"exists":"cc"}', message: "must be qualified" },
			{ where: '{"exists":"email.from"}', message: "Unsupported metadata kind" },
			{ where: '{"eq":["frontmatter.cc",["bob"]]}', message: "not searchable" },
			{ where: '{"prefix":["frontmatter.amount",12]}', message: "string values only" },
		];

		for (const item of cases) {
			const { command, commandCtx, runQuery } = create_command_runner();
			const result = await command.execute(["search", "--where", item.where], commandCtx);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain(item.message);
			expect(runQuery).not.toHaveBeenCalled();
		}
	});

	test("rejects extra predicate keys instead of silently dropping them", async () => {
		const cases = [
			'{"eq":["frontmatter.from","a@b.com"],"eq2":0}',
			'{"eq":["frontmatter.priority",3],"exists":"frontmatter.from"}',
		];

		for (const where of cases) {
			const { command, commandCtx, runQuery } = create_command_runner();
			const result = await command.execute(["search", "--where", where], commandCtx);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("one indexed field predicate");
			expect(runQuery).not.toHaveBeenCalled();
		}
	});

	test("range errors point at the bounds-object shape with an example", async () => {
		const cases = [
			{
				where: '{"range":["frontmatter.estimate",5,120]}',
				message: '{"range":["frontmatter.estimate",{"gte":5,"lte":120}]}',
			},
			{ where: '{"range":["frontmatter.estimate",5]}', message: "bounds object" },
		];

		for (const item of cases) {
			const { command, commandCtx, runQuery } = create_command_runner();
			const result = await command.execute(["search", "--where", item.where], commandCtx);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain(item.message);
			expect(runQuery).not.toHaveBeenCalled();
		}
	});
});
