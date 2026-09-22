import { Workpool } from "@convex-dev/workpool";
import { Bash, InMemoryFs, MountableFs } from "just-bash/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { bash_cat_command_create } from "./bash-cat-command.ts";
import { bash_head_tail_wc_command_create } from "./bash-head-tail-wc-command.ts";
import { bash_ls_command_create } from "./bash-ls-command.ts";
import { bash_nested_shell_command_create } from "./bash-nested-shell-command.ts";
import { bash_resolve_command_create } from "./bash-resolve-command.ts";
import { bash_rm_command_create } from "./bash-rm-command.ts";
import { bash_stat_command_create } from "./bash-stat-command.ts";
import { bash_tee_command_create } from "./bash-tee-command.ts";
import { bash_touch_command_create } from "./bash-touch-command.ts";
import { bash_xargs_command_create } from "./bash-xargs-command.ts";
import { bash_DbFilesFs, bash_READER_FILE_OPERAND_MAX, type bash_DbFilesRoots } from "./bash-utils.ts";

const teamPath = "/home/cloud-usr/w/team/home";
const homePath = "/home/cloud-usr/w/personal/home";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("bash-workspaces-billing" as never);
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const t = test_convex();
	const team = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "team", workspaceName: "home" }),
	);
	const home = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			userId: team.userId,
			organizationName: "personal",
			workspaceName: "home",
		}),
	);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: team.userId });
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: team.membershipId,
		clientGeneratedId: "two-workspace-commands",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: team.userId,
		membershipId: team.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const agentSource = {
		...team,
		threadId: created._yay.threadId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	let toolCallNumber = 0;
	const runRuntime = (command: string, agent = true, shellName = "default") =>
		t.action(internal.bash.run, {
			...agentSource,
			organizationName: "team",
			workspaceName: "home",
			command,
			toolCallId: `workspace-call-${toolCallNumber++}`,
			allowDbFilesMkdir: agent,
			shellName,
			wakeAgent: null,
		});
	const run = (script: string, agent = true) =>
		t.action(async (ctx) => {
			const roots: bash_DbFilesRoots = {
				app: {
					currentWorkspacePath: teamPath,
					fs: new bash_DbFilesFs({
						ctx,
						currentWorkspacePath: teamPath,
						allowDbFilesMkdir: agent,
						ctxData: { ...captured._yay.current, userId: team.userId, threadId: created._yay.threadId, agentSource },
					}),
				},
				personal: {
					currentWorkspacePath: homePath,
					fs: new bash_DbFilesFs({
						ctx,
						currentWorkspacePath: homePath,
						allowDbFilesMkdir: agent,
						ctxData: { ...captured._yay.personal, userId: team.userId, threadId: created._yay.threadId, agentSource },
					}),
				},
				externalMounts: { currentWorkspacePath: "/.mounts", mounts: new Map() },
				plugins: { currentWorkspacePath: "/.plugins", mounts: new Map() },
			};
			const shell = new Bash({
				cwd: teamPath,
				fs: new MountableFs({
					base: new InMemoryFs(),
					mounts: [roots.app, roots.personal!].map((root) => ({
						mountPoint: root.currentWorkspacePath,
						filesystem: root.fs,
					})),
				}),
				customCommands: [
					bash_cat_command_create(ctx, roots),
					bash_ls_command_create(ctx, roots),
					bash_resolve_command_create(ctx, roots),
					bash_rm_command_create(ctx, roots),
					bash_stat_command_create(ctx, roots),
					bash_head_tail_wc_command_create(ctx, roots, "head"),
					bash_head_tail_wc_command_create(ctx, roots, "tail"),
					bash_head_tail_wc_command_create(ctx, roots, "wc"),
					bash_tee_command_create(roots),
					bash_touch_command_create(roots),
					bash_nested_shell_command_create("bash", roots),
					bash_nested_shell_command_create("sh", roots),
					bash_xargs_command_create(roots),
				],
			});
			return await shell.exec(script);
		});
	return { t, team, home, asUser, run, runRuntime };
}

describe("Bash workspace runtime", () => {
	test("relative find prefixes and retry hints follow a personal cwd", async () => {
		const f = await fixture();
		expect(
			(await f.runRuntime(`mkdir ${homePath}/docs; printf home > ${homePath}/docs/notes.txt; cd ${homePath}`)).metadata
				.exitCode,
		).toBe(0);
		const found = await f.runRuntime("find --prefix docs -type f", false);
		expect(found).toMatchObject({ stderr: "", metadata: { exitCode: 0 } });
		expect(found.stdout).toContain(`${homePath}/docs/notes.txt`);
		const hint = await f.runRuntime("find -name '*notes*'", false);
		expect(hint.metadata.exitCode).not.toBe(0);
		expect(hint.stderr).toContain(homePath);
		expect(hint.stderr).not.toContain(teamPath);
	});

	test.each([
		"false && value=$(cat docs/missing.txt); echo done",
		"bash -c 'false && value=$(cat docs/missing.txt); echo done'",
		"printf '%s\\n' 'false && value=$(cat docs/missing.txt); echo done' | xargs -I {} bash -c '{}'",
	])("does not record personal paths from safety probes: %s", async (command) => {
		const f = await fixture();
		expect((await f.runRuntime(`printf home > ${homePath}/notes.txt; cd ${homePath}`)).metadata.exitCode).toBe(0);
		const result = await f.runRuntime(`cat notes.txt > /tmp/read; ${command}`, false);
		expect(result).toMatchObject({ stdout: "done\n", stderr: "", metadata: { exitCode: 0 } });
		expect(result.metadata.observedPaths).toEqual([{ workspace: "personal", path: "/notes.txt" }]);
	});

	test("mounts both workspaces and keeps matching paths distinct", async () => {
		const f = await fixture();
		const result = await f.runRuntime(
			`printf team > notes.txt; printf home > ${homePath}/notes.txt; cat notes.txt; cat ${homePath}/notes.txt; cat notes.txt`,
		);
		expect(result).toMatchObject({ stdout: "teamhometeam", stderr: "", metadata: { exitCode: 0 } });
		expect(result.metadata.observedPaths).toEqual([
			{ workspace: "current", path: "/notes.txt" },
			{ workspace: "personal", path: "/notes.txt" },
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ workspaceId: f.team.workspaceId, userId: f.team.userId, name: "notes.txt" }),
				expect.objectContaining({ workspaceId: f.home.workspaceId, userId: f.team.userId, name: "notes.txt" }),
			]),
		);
		expect(await f.runRuntime(`cat ${homePath}/notes.txt; cat notes.txt`, false, "ask")).toMatchObject({
			stdout: "hometeam",
			stderr: "",
			metadata: { exitCode: 0 },
		});
	});

	test("restores a personal cwd across calls and a pending folder rename", async () => {
		const f = await fixture();
		expect((await f.runRuntime(`mkdir ${homePath}/notes; cd ${homePath}/notes`)).metadata.exitCode).toBe(0);
		const folder = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").first());
		if (!folder) throw new Error("Expected a personal folder");
		expect(
			await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: f.home.organizationId,
				workspaceId: f.home.workspaceId,
				userId: f.team.userId,
				target: { kind: "private", id: folder._id },
				destParent: { kind: "root" },
				destName: "renamed",
			}),
		).toMatchObject({ _yay: expect.anything() });
		const result = await f.runRuntime("pwd; printf private > draft.txt");
		expect(result).toMatchObject({
			stdout: `${homePath}/renamed\n`,
			stderr: "",
			metadata: { exitCode: 0, nextCwd: `${homePath}/renamed` },
		});
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_bash_shells").first())).toMatchObject({
			cwd: `${homePath}/renamed`,
			cwdTarget: { kind: "private", id: folder._id },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toContainEqual(
			expect.objectContaining({
				workspaceId: f.home.workspaceId,
				parent: { kind: "private", id: folder._id },
				name: "draft.txt",
			}),
		);
	});

	test("has one observed-path budget for the pair", async () => {
		const f = await fixture();
		const paths = Array.from({ length: 120 }, (_, i) => `${i % 2 ? teamPath : homePath}/missing-${i}.txt`);
		const commands = Array.from({ length: 12 }, (_, i) => `stat ${paths.slice(i * 10, i * 10 + 10).join(" ")}`);
		const result = await f.runRuntime(commands.join("; "), false);
		expect(result.metadata).toMatchObject({ observedPathsTruncated: true });
		expect(result.metadata.observedPaths).toHaveLength(100);
		expect(new Set(result.metadata.observedPaths.map((entry) => entry.workspace))).toEqual(
			new Set(["current", "personal"]),
		);
	});

	test("does not create files outside the allowed pair", async () => {
		const f = await fixture();
		for (const path of ["/home/cloud-usr/w/team/other/notes.txt", `${homePath}/../other/notes.txt`]) {
			const result = await f.runRuntime(`printf private > ${path}`);
			expect(result.metadata.exitCode).not.toBe(0);
		}
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
	});
});

describe("Bash workspace commands", () => {
	test.each(["bash", "sh"])("%s cannot execute personal files, directly or through xargs", async (command) => {
		const f = await fixture();
		expect((await f.run(`printf 'printf PRIVATE_EXECUTED' > ${homePath}/script.sh`)).exitCode).toBe(0);
		for (const script of [
			`${command} ${homePath}/script.sh`,
			`cd ${homePath}; ${command} script.sh`,
			`printf '%s' '${homePath}/script.sh' | xargs ${command}`,
		]) {
			const result = await f.run(script);
			expect(result.exitCode).toBe(126);
			expect(result.stdout).not.toContain("PRIVATE_EXECUTED");
			expect(result.stderr).toContain("app-mounted script files are not executable");
		}
		expect(await f.run(`cat ${homePath}/script.sh`)).toMatchObject({
			exitCode: 0,
			stdout: "printf PRIVATE_EXECUTED",
		});
		expect(await f.run(`printf 'printf SCRATCH_EXECUTED' > /tmp/script.sh; ${command} /tmp/script.sh`)).toMatchObject({
			exitCode: 0,
			stdout: "SCRATCH_EXECUTED",
		});
	});

	test("writes and reads matching paths without mixing bodies or storage owners", async () => {
		const f = await fixture();
		const result = await f.run(
			`printf team > notes.txt; printf home > ${homePath}/notes.txt; cat notes.txt; cat ${homePath}/notes.txt; cat notes.txt`,
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "teamhometeam", stderr: "" });
		const files = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(files).toHaveLength(2);
		for (const scope of [f.team, f.home]) {
			expect(files.find((file) => file.workspaceId === scope.workspaceId)).toMatchObject({
				organizationId: scope.organizationId,
				userId: f.team.userId,
				name: "notes.txt",
			});
		}
	});

	test.each(["cat", "head", "tail", "wc", "stat"])(
		"%s shares one reader limit across both workspaces",
		async (command) => {
			const f = await fixture();
			expect((await f.run(`printf team > notes.txt; printf home > ${homePath}/notes.txt`)).exitCode).toBe(0);
			const paths = Array.from(
				{ length: bash_READER_FILE_OPERAND_MAX + 1 },
				(_, i) => `${i % 2 ? teamPath : homePath}/notes.txt`,
			);
			expect((await f.run(`${command} ${paths.slice(0, bash_READER_FILE_OPERAND_MAX).join(" ")}`)).exitCode).toBe(0);
			const result = await f.run(`${command} ${paths.join(" ")}`);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(`reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		},
	);

	test.each(["tee", "touch"])("%s refuses personal writes in Ask mode before scratch changes", async (command) => {
		const f = await fixture();
		const result = await f.run(
			`printf data | ${command} /tmp/scratch.txt ${homePath}/notes.txt; test ! -e /tmp/scratch.txt`,
			false,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Ask mode");
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
	});

	test.each(["tee", "touch"])("%s can write personal drafts and scratch in Agent mode", async (command) => {
		const f = await fixture();
		const result = await f.run(
			`printf data | ${command} /tmp/scratch.txt ${homePath}/notes.txt; test -e /tmp/scratch.txt`,
		);
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		const files = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(files).toEqual([expect.objectContaining({ workspaceId: f.home.workspaceId, name: "notes.txt" })]);
		expect(
			await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: f.home.organizationId,
				workspaceId: f.home.workspaceId,
				userId: f.team.userId,
				overlayUserId: f.team.userId,
				path: "/notes.txt",
				mode: { kind: "full", maxBytes: 1024 },
			}),
		).toMatchObject({ content: command === "tee" ? "data" : "" });
	});

	test("personal recency links use the personal root", async () => {
		const f = await fixture();
		expect((await f.run(`printf home > ${homePath}/notes.txt`)).exitCode).toBe(0);
		const result = await f.run(`cd ${homePath}; ls -t`);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`${homePath}/notes.txt`);
		expect(result.stdout).not.toContain(`${teamPath}/notes.txt`);
	});

	test("rm removes only the personal draft at a matching path", async () => {
		const f = await fixture();
		expect((await f.run(`printf team > notes.txt; printf home > ${homePath}/notes.txt`)).exitCode).toBe(0);
		const result = await f.run(`rm ${homePath}/notes.txt; cat notes.txt`);
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toContain(`removed '${homePath}/notes.txt'`);
		expect(result.stdout).toContain("team");
		expect(
			await f.t.query(internal.files_nodes.get_visible_entry_by_path, {
				organizationId: f.home.organizationId,
				workspaceId: f.home.workspaceId,
				visibilityUserId: f.team.userId,
				overlayUserId: f.team.userId,
				path: "/notes.txt",
			}),
		).toBeNull();
		expect(
			await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: f.team.organizationId,
				workspaceId: f.team.workspaceId,
				userId: f.team.userId,
				overlayUserId: f.team.userId,
				path: "/notes.txt",
				mode: { kind: "full", maxBytes: 1024 },
			}),
		).toMatchObject({ content: "team" });
	});

	test("resolves personal IDs and URLs but refuses a third workspace", async () => {
		const f = await fixture();
		expect((await f.run(`printf home > ${homePath}/notes.txt`)).exitCode).toBe(0);
		const personalFile = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").first());
		if (!personalFile) throw new Error("Expected a personal draft");
		for (const reference of [
			personalFile._id,
			`https://app.example/w/personal/home/files?pendingNodeId=${personalFile._id}`,
		]) {
			expect(await f.run(`resolve '${reference}'`)).toMatchObject({ exitCode: 0, stdout: `${homePath}/notes.txt\n` });
		}
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: f.team.userId,
				organizationName: "third",
				workspaceName: "home",
			}),
		);
		const thirdFolder = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: third.organizationId,
			workspaceId: third.workspaceId,
			userId: third.userId,
			path: "/third-notes",
			kind: "folder",
		});
		if (thirdFolder._nay) throw new Error(thirdFolder._nay.message);
		for (const reference of [
			thirdFolder._yay.target.id,
			`https://app.example/w/third/home/files?pendingNodeId=${personalFile._id}`,
		]) {
			const result = await f.run(`resolve '${reference}'`);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("unavailable");
		}
	});
});
