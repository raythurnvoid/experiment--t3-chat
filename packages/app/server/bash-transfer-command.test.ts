import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { Bash, InMemoryFs, MountableFs, type CommandContext } from "just-bash/browser";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { internal } from "../convex/_generated/api.js";
import {
	bash_ABORT_REASON_STOPPED,
	bash_DbFilesContentUnavailableError,
	bash_DbFilesFs,
	bash_parse_cp_mv_operands,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_transfer_command_prepare, bash_transfer_command_run } from "./bash-transfer-command.ts";
import { bash_cp_command_create } from "./bash-cp-command.ts";
import { bash_mv_command_create } from "./bash-mv-command.ts";

const teamPath = "/home/cloud-usr/w/team/work";
const homePath = "/home/cloud-usr/w/personal/home";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function create_runner(currentWorkspacePath = homePath, allowDbFilesMkdir = true) {
	const runId = "transfer_1" as Id<"files_transfer_runs">;
	const activityId = "activity_1" as Id<"activities">;
	const runMutation = vi.fn().mockResolvedValue({ _yay: { runId, activityId } });
	const runQuery = vi.fn().mockResolvedValue({
		runId,
		activity: { _id: activityId, status: "succeeded", progress: { completed: 2, skipped: 0, failed: 0 } },
	});
	const ctx = { runMutation, runQuery, runAction: vi.fn() } as unknown as ActionCtx;
	const fs = new bash_DbFilesFs({
		ctx,
		currentWorkspacePath,
		allowDbFilesMkdir,
		ctxData: {
			organizationId: "organization_1" as Id<"organizations">,
			workspaceId: "workspace_1" as Id<"organizations_workspaces">,
			organizationName: currentWorkspacePath === homePath ? "personal" : "team",
			workspaceName: currentWorkspacePath === homePath ? "home" : "work",
			userId: "user_1" as Id<"users">,
			threadId: "thread_1" as Id<"ai_chat_threads">,
		},
	});
	const entries = new Map<string, NonNullable<Awaited<ReturnType<typeof fs.getEntry>>>>();
	entries.set("/", {
		target: { kind: "root" },
		path: "/",
		name: "",
		kind: "folder",
		updatedAt: 1,
		assetId: null,
		textKind: null,
	});
	for (const [path, kind] of [
		["/a.txt", "file"],
		["/b.txt", "file"],
		["/source", "folder"],
		["/dest", "folder"],
	] as const)
		entries.set(path, {
			target: { kind: "saved", id: path as Id<"files_nodes"> },
			path,
			name: path.slice(1),
			kind,
			updatedAt: 1,
			assetId: null,
			textKind: kind === "file" ? "plain_text" : null,
		});
	vi.spyOn(fs, "getEntry").mockImplementation(async (path) => entries.get(path) ?? null);
	const reset = vi.spyOn(fs, "resetProposalCaches");
	const dbFilesRoots: bash_DbFilesRoots = {
		app: { currentWorkspacePath, fs },
		personal: null,
		externalMounts: { currentWorkspacePath: "/.mounts", mounts: new Map() },
		plugins: { currentWorkspacePath: "/.plugins", mounts: new Map() },
	};
	const personalEntries = new Map<string, NonNullable<Awaited<ReturnType<typeof fs.getEntry>>>>(
		[...entries].map(([path, entry]) => [
			path,
			{
				...entry,
				target:
					path === "/"
						? { kind: "root" as const }
						: { kind: "saved" as const, id: `personal:${path}` as Id<"files_nodes"> },
			},
		]),
	);
	if (currentWorkspacePath !== homePath) {
		const personalFs = new bash_DbFilesFs({
			ctx,
			currentWorkspacePath: homePath,
			allowDbFilesMkdir,
			ctxData: {
				...fs.ctxData,
				organizationId: "personal_organization" as Id<"organizations">,
				workspaceId: "personal_workspace" as Id<"organizations_workspaces">,
				organizationName: "personal",
				workspaceName: "home",
			},
		});
		vi.spyOn(personalFs, "getEntry").mockImplementation(async (path) => personalEntries.get(path) ?? null);
		dbFilesRoots.personal = { currentWorkspacePath: homePath, fs: personalFs };
	}
	const controller = new AbortController();
	const transferContext = {
		invocationId: "invocation_1" as Id<"ai_chat_bash_invocations">,
		membershipId: "membership_1" as Id<"organizations_workspaces_users">,
		deadlineAt: Date.now() + 90_000,
		signal: controller.signal,
		abort: vi.fn((reason?: unknown) => controller.abort(reason)),
		nextCommandNumber: vi.fn().mockReturnValue(4),
		jobId: null as Id<"ai_chat_bash_invocations"> | null,
	};
	const run = (command: "cp" | "mv", args: string[]) => {
		const parsed = bash_parse_cp_mv_operands(command, args);
		if (parsed._nay) throw new Error(parsed._nay.message);
		return bash_transfer_command_run({
			ctx,
			dbFilesRoots,
			transferContext,
			command,
			commandCtx: { cwd: currentWorkspacePath } as CommandContext,
			parsed: parsed._yay,
		});
	};
	const scratch = new InMemoryFs({ "/tmp/input.txt": "scratch\n" });
	const shell = new Bash({
		cwd: currentWorkspacePath,
		fs: new MountableFs({
			base: scratch,
			mounts: [dbFilesRoots.app, ...(dbFilesRoots.personal ? [dbFilesRoots.personal] : [])].map((root) => ({
				mountPoint: root.currentWorkspacePath,
				filesystem: root.fs,
			})),
		}),
		customCommands: [
			bash_cp_command_create(ctx, dbFilesRoots, transferContext),
			bash_mv_command_create(ctx, dbFilesRoots, transferContext),
		],
	});
	return {
		ctx,
		run,
		shell,
		scratch,
		dbFilesRoots,
		runMutation,
		runQuery,
		runId,
		activityId,
		entries,
		personalEntries,
		transferContext,
		reset,
	};
}

describe("bash_transfer_command_run", () => {
	test("preparation captures real source IDs without admitting work or allocating a command number", async () => {
		const runner = create_runner(teamPath);
		const parsed = bash_parse_cp_mv_operands("cp", ["a.txt", `${homePath}/dest`]);
		if (parsed._nay) throw new Error(parsed._nay.message);
		const preparation = await bash_transfer_command_prepare({
			ctx: runner.ctx,
			dbFilesRoots: runner.dbFilesRoots,
			transferContext: runner.transferContext,
			command: "cp",
			commandCtx: { cwd: teamPath },
			parsed: parsed._yay,
		});
		if (!("prepared" in preparation)) throw new Error(preparation.result.stderr);
		expect(preparation.prepared).toMatchObject({
			sources: [{ kind: "saved", id: "/a.txt" }],
			targetParent: { kind: "saved", id: "personal:/dest" },
			targetPath: "/dest",
			sourceRoot: { ctxData: { workspaceId: "workspace_1" } },
			destinationRoot: { ctxData: { workspaceId: "personal_workspace" } },
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
		});
		expect(runner.runMutation).not.toHaveBeenCalled();
		expect(runner.runQuery).not.toHaveBeenCalled();
		expect(runner.transferContext.nextCommandNumber).not.toHaveBeenCalled();
	});

	test.each([1, 100, 101, 201])("Copy sends %i selected sources in pages and seals before waiting", async (count) => {
		const runner = create_runner();
		const sources = Array.from({ length: count }, (_, index) => (index % 2 ? "b.txt" : "a.txt"));
		let accepted = 0;
		let sealed = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const name = getFunctionName(ref);
			if (name === "files_transfer:start_for_agent") {
				expect(args.expectedSourceCount).toBe(count);
				expect(args.sources).toHaveLength(Math.min(count, 100));
				accepted = args.sources.length;
				return { _yay: { runId: runner.runId, activityId: runner.activityId } };
			}
			if (name === "files_transfer:append_sources_for_agent") {
				expect(args.offset).toBe(accepted);
				expect(args.sources.length).toBeLessThanOrEqual(100);
				expect(args.sources).toEqual(
					sources.slice(accepted, accepted + 100).map((path) => ({ kind: "saved", id: `/${path}` })),
				);
				accepted += args.sources.length;
				return { _yay: null };
			}
			expect(name).toBe("files_transfer:seal_for_agent");
			expect(accepted).toBe(count);
			sealed = true;
			return { _yay: null };
		});
		runner.runQuery.mockImplementation(async () => {
			expect(sealed).toBe(true);
			return { activity: { status: "succeeded", progress: { completed: 2, skipped: 0, failed: 0 } } };
		});
		expect(await runner.run("cp", [...sources, "dest"])).toMatchObject({ exitCode: 0 });
		expect(sealed).toBe(true);
		expect(runner.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
			"files_transfer:start_for_agent",
			...Array.from({ length: Math.ceil(count / 100) - 1 }, () => "files_transfer:append_sources_for_agent"),
			"files_transfer:seal_for_agent",
		]);
	});

	test("same-workspace Move keeps its bounded start without Copy intake", async () => {
		const runner = create_runner();
		expect(await runner.run("mv", ["a.txt", "dest"])).toMatchObject({ exitCode: 0 });
		expect(runner.runMutation).toHaveBeenCalledTimes(1);
		expect(runner.runMutation.mock.calls[0]![1]).not.toHaveProperty("expectedSourceCount");
		expect(await runner.run("mv", [...Array.from({ length: 201 }, () => "a.txt"), "dest"])).toMatchObject({
			exitCode: 1,
			stderr: "mv: select at most 200 sources\n",
		});
		expect(runner.runMutation).toHaveBeenCalledTimes(1);
	});

	test.each(["append_sources_for_agent", "seal_for_agent"])("stops accepted Copy when %s refuses", async (door) => {
		const runner = create_runner();
		runner.runMutation.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === `files_transfer:${door}`) return { _nay: { message: "Copy intake refused" } };
			return getFunctionName(ref) === "files_transfer:start_for_agent"
				? { _yay: { runId: runner.runId, activityId: runner.activityId } }
				: { _yay: null };
		});
		expect(await runner.run("cp", [...Array.from({ length: 101 }, () => "a.txt"), "dest"])).toMatchObject({
			exitCode: 1,
			stderr: "cp: Copy intake refused\n",
		});
		expect(runner.runMutation).toHaveBeenLastCalledWith(
			internal.files_transfer.stop_for_agent,
			expect.objectContaining({ runId: runner.runId, reason: "user" }),
		);
		expect(runner.runQuery).not.toHaveBeenCalled();
	});

	test.each(["append_sources_for_agent", "seal_for_agent"])(
		"a lost %s reply stops Copy and prevents the next shell write",
		async (door) => {
			const runner = create_runner();
			let stopped = false;
			runner.runMutation.mockImplementation(async (ref, args) => {
				const name = getFunctionName(ref);
				if (name === `files_transfer:${door}`) throw new Error("Lost intake reply");
				if (name === "files_transfer:stop_for_agent") {
					expect(args.reason).toBe("user");
					stopped = true;
				}
				return name === "files_transfer:start_for_agent"
					? { _yay: { runId: runner.runId, activityId: runner.activityId } }
					: { _yay: null };
			});
			const command = `cp ${Array.from({ length: 101 }, () => "a.txt").join(" ")} dest; echo unsafe > /tmp/after.txt`;
			await runner.shell.exec(command, { signal: runner.transferContext.signal });
			expect(stopped).toBe(true);
			expect(runner.transferContext.signal.aborted).toBe(true);
			expect(await runner.scratch.exists("/tmp/after.txt")).toBe(false);
			expect(
				runner.runMutation.mock.calls.filter(([ref]) => getFunctionName(ref) === `files_transfer:${door}`),
			).toHaveLength(1);
		},
	);

	test.each(["stop", "deadline"])("%s after start stops unsealed Copy before sending another page", async (reason) => {
		vi.useFakeTimers();
		const runner = create_runner();
		runner.runMutation.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_transfer:start_for_agent") {
				if (reason === "stop") runner.transferContext.abort(bash_ABORT_REASON_STOPPED);
				else vi.setSystemTime(runner.transferContext.deadlineAt);
				return { _yay: { runId: runner.runId, activityId: runner.activityId } };
			}
			return { _yay: null };
		});
		expect(await runner.run("cp", [...Array.from({ length: 101 }, () => "a.txt"), "dest"])).toMatchObject({
			exitCode: reason === "stop" ? 143 : 124,
		});
		expect(runner.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
			"files_transfer:start_for_agent",
			"files_transfer:stop_for_agent",
		]);
		expect(runner.runQuery).not.toHaveBeenCalled();
	});

	test.each([
		["a.txt", `${homePath}/dest`],
		[`${homePath}/a.txt`, "dest"],
		["-f", "a.txt", `${homePath}/dest/new.txt`],
		["-n", "a.txt", `${homePath}/dest`],
		["-T", "source", `${homePath}/dest`],
		["--", "missing.txt", `${homePath}/missing/parent/file.txt`],
		["a.txt", `${homePath}/b.txt`, "dest"],
		[`${homePath}/a.txt`, "b.txt", "dest"],
		["a.txt", "b.txt", `${homePath}/dest`],
		["./a.txt", "../../personal/home/dest/../dest"],
	])("refuses cross-workspace mv before any entry read: %j", async (...operands) => {
		const runner = create_runner(teamPath);
		expect(await runner.run("mv", operands)).toEqual({
			stdout: "",
			stderr:
				"mv: Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.\n",
			exitCode: 1,
		});
		expect(vi.spyOn(runner.dbFilesRoots.app.fs, "getEntry")).not.toHaveBeenCalled();
		expect(vi.spyOn(runner.dbFilesRoots.personal!.fs, "getEntry")).not.toHaveBeenCalled();
		expect(runner.transferContext.nextCommandNumber).not.toHaveBeenCalled();
		expect(runner.runMutation).not.toHaveBeenCalled();
		expect(runner.runQuery).not.toHaveBeenCalled();
		expect(runner.reset).not.toHaveBeenCalled();
	});

	test("refuses cross-workspace mv within one organization", async () => {
		const runner = create_runner(teamPath);
		runner.dbFilesRoots.personal!.fs.ctxData.organizationId = runner.dbFilesRoots.app.fs.ctxData.organizationId;
		expect(await runner.run("mv", ["a.txt", `${homePath}/dest`])).toEqual({
			stdout: "",
			stderr:
				"mv: Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.\n",
			exitCode: 1,
		});
		expect(vi.spyOn(runner.dbFilesRoots.app.fs, "getEntry")).not.toHaveBeenCalled();
		expect(vi.spyOn(runner.dbFilesRoots.personal!.fs, "getEntry")).not.toHaveBeenCalled();
		expect(runner.runMutation).not.toHaveBeenCalled();
		expect(runner.runQuery).not.toHaveBeenCalled();
	});

	test("allows mv when different root selectors resolve to the same workspace IDs", async () => {
		const runner = create_runner(teamPath);
		Object.assign(runner.dbFilesRoots.personal!.fs.ctxData, {
			organizationId: runner.dbFilesRoots.app.fs.ctxData.organizationId,
			workspaceId: runner.dbFilesRoots.app.fs.ctxData.workspaceId,
		});
		expect(await runner.run("mv", ["a.txt", `${homePath}/b.txt`, "dest"])).toMatchObject({
			exitCode: 0,
			stderr: "",
		});
		expect(runner.runMutation).toHaveBeenCalledExactlyOnceWith(
			internal.files_transfer.start_for_agent,
			expect.objectContaining({
				kind: "move",
				sources: [runner.entries.get("/a.txt")!.target, runner.personalEntries.get("/b.txt")!.target],
			}),
		);
	});

	test.each([
		[teamPath, homePath, "current", "personal", "/a.txt", "personal:/dest"],
		[homePath, teamPath, "personal", "current", "personal:/a.txt", "/dest"],
	])(
		"cp routes from %s and keeps the current chat invocation",
		async (sourcePath, destinationPath, sourceWorkspace, destinationWorkspace, sourceId, parentId) => {
			const runner = create_runner(teamPath);
			const personalReset = vi.spyOn(runner.dbFilesRoots.personal!.fs, "resetProposalCaches");
			const result = await runner.run("cp", [`${sourcePath}/a.txt`, `${destinationPath}/dest`]);
			expect(result).toMatchObject({ exitCode: 0, stderr: "" });
			expect(runner.runMutation).toHaveBeenNthCalledWith(
				1,
				internal.files_transfer.start_for_agent,
				expect.objectContaining({
					membershipId: runner.transferContext.membershipId,
					threadId: "thread_1",
					invocation: { id: runner.transferContext.invocationId, commandNumber: 4 },
					requestId: `${runner.transferContext.invocationId}:4`,
					sourceWorkspace,
					destinationWorkspace,
					kind: "copy",
					sources: [{ kind: "saved", id: sourceId }],
					targetParent: { kind: "saved", id: parentId },
					targetPath: "/dest",
					targetName: null,
				}),
			);
			expect(runner.runQuery).toHaveBeenCalledExactlyOnceWith(internal.files_transfer.get_for_agent, {
				membershipId: runner.transferContext.membershipId,
				threadId: "thread_1",
				runId: runner.runId,
			});
			expect(runner.reset).toHaveBeenCalledTimes(1);
			expect(personalReset).toHaveBeenCalledTimes(1);
		},
	);

	test.each([teamPath, homePath])(
		"reads the visible source in %s and clears both content caches",
		async (sourcePath) => {
			const runner = create_runner(teamPath);
			const sourceFs = sourcePath === teamPath ? runner.dbFilesRoots.app.fs : runner.dbFilesRoots.personal!.fs;
			const destinationFs = sourcePath === teamPath ? runner.dbFilesRoots.personal!.fs : runner.dbFilesRoots.app.fs;
			const destinationPath = sourcePath === teamPath ? homePath : teamPath;
			for (const fs of [sourceFs, destinationFs]) vi.spyOn(fs, "getEntry").mockRestore();
			const sourceCache = new Map([["/a.txt", "old source"]]);
			const destinationCache = new Map([["/dest/a.txt", "old destination"]]);
			sourceFs.linkProposalCache(sourceCache);
			destinationFs.linkProposalCache(destinationCache);
			runner.runQuery.mockImplementation(async (ref, args) => {
				if (getFunctionName(ref) === "files_nodes:get_visible_entry_by_path") {
					const entries =
						args.workspaceId === runner.dbFilesRoots.app.fs.ctxData.workspaceId
							? runner.entries
							: runner.personalEntries;
					const entry = entries.get(args.path);
					if (!entry?.target || entry.target.kind === "root") return null;
					return {
						kind: "saved",
						node: { ...entry, _id: entry.target.id, contentType: "application/octet-stream" },
						pendingUpdate: null,
					};
				}
				return { activity: { status: "succeeded", progress: { completed: 1, skipped: 0, failed: 0 } } };
			});
			expect(await runner.run("cp", [`${sourcePath}/a.txt`, `${destinationPath}/dest`])).toMatchObject({
				exitCode: 0,
				stderr: "",
			});
			for (const [fs, path] of [
				[sourceFs, "/a.txt"],
				[destinationFs, "/dest"],
			] as const)
				expect(runner.runQuery).toHaveBeenCalledWith(
					internal.files_nodes.get_visible_entry_by_path,
					expect.objectContaining({
						organizationId: fs.ctxData.organizationId,
						workspaceId: fs.ctxData.workspaceId,
						visibilityUserId: fs.ctxData.userId,
						overlayUserId: fs.ctxData.userId,
						path,
					}),
				);
			expect(sourceCache.size).toBe(0);
			expect(destinationCache.size).toBe(0);
		},
	);

	test("cp refuses mixed roots without a transfer or file read", async () => {
		const runner = create_runner(teamPath);
		const currentRead = vi.spyOn(runner.dbFilesRoots.app.fs, "getEntry");
		const personalRead = vi.spyOn(runner.dbFilesRoots.personal!.fs, "getEntry");
		expect(await runner.run("cp", ["a.txt", `${homePath}/b.txt`, "dest"])).toMatchObject({
			exitCode: 1,
			stderr: expect.stringContaining("all sources must be in one workspace"),
		});
		expect(runner.runMutation).not.toHaveBeenCalled();
		expect(currentRead).not.toHaveBeenCalled();
		expect(personalRead).not.toHaveBeenCalled();
	});

	test("cross-workspace Copy Stop and lane reads keep the current chat scope", async () => {
		const runner = create_runner(teamPath);
		const personalReset = vi.spyOn(runner.dbFilesRoots.personal!.fs, "resetProposalCaches");
		runner.transferContext.jobId = "job_1" as Id<"ai_chat_bash_invocations">;
		runner.runQuery.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_transfer:get_current_activity_for_agent") return null;
			runner.transferContext.abort(bash_ABORT_REASON_STOPPED);
			return { activity: { status: "running" } };
		});
		runner.runMutation.mockImplementation(async (ref) =>
			getFunctionName(ref) === "files_transfer:stop_for_agent"
				? { _yay: null }
				: { _yay: { runId: runner.runId, activityId: runner.activityId } },
		);
		expect(await runner.run("cp", [`${homePath}/a.txt`, "dest"])).toMatchObject({ exitCode: 143, stdout: "" });
		expect(runner.runQuery).toHaveBeenCalledWith(internal.files_transfer.get_current_activity_for_agent, {
			membershipId: runner.transferContext.membershipId,
			threadId: "thread_1",
		});
		expect(runner.runMutation).toHaveBeenLastCalledWith(internal.files_transfer.stop_for_agent, {
			membershipId: runner.transferContext.membershipId,
			threadId: "thread_1",
			runId: runner.runId,
			reason: "user",
		});
		expect(runner.reset).toHaveBeenCalledTimes(1);
		expect(personalReset).toHaveBeenCalledTimes(1);
	});

	test("reports a cross-workspace Copy preparation failure", async () => {
		const runner = create_runner(teamPath);
		runner.runQuery.mockResolvedValue({ activity: { status: "failed", errorMessage: "Copy failed" } });
		const result = await runner.run("cp", ["a.txt", `${homePath}/dest`]);
		expect(result).toMatchObject({ exitCode: 1, stderr: "cp: Copy failed\n" });
	});

	describe("Bash operand routing", () => {
		test.each([
			`mv -f a.txt ${homePath}/dest && printf 'must not run'`,
			`mv -n ${homePath}/a.txt dest`,
			`mv a.txt ${homePath}/b.txt dest`,
			`bash -c 'mv a.txt ${homePath}/dest'`,
		])("refuses cross-workspace mv through the shell: %s", async (command) => {
			const runner = create_runner(teamPath);
			expect(await runner.shell.exec(command)).toMatchObject({
				stdout: "",
				stderr:
					"mv: Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.\n",
				exitCode: 1,
			});
			expect(vi.spyOn(runner.dbFilesRoots.app.fs, "getEntry")).not.toHaveBeenCalled();
			expect(vi.spyOn(runner.dbFilesRoots.personal!.fs, "getEntry")).not.toHaveBeenCalled();
			expect(runner.runMutation).not.toHaveBeenCalled();
			expect(runner.runQuery).not.toHaveBeenCalled();
		});

		test("refuses cross-workspace mv in a job before checking the transfer lane", async () => {
			const runner = create_runner(teamPath);
			runner.transferContext.jobId = "job_1" as Id<"ai_chat_bash_invocations">;
			expect(await runner.shell.exec(`mv a.txt ${homePath}/dest`)).toMatchObject({
				stdout: "",
				stderr:
					"mv: Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.\n",
				exitCode: 1,
			});
			expect(runner.runMutation).not.toHaveBeenCalled();
			expect(runner.runQuery).not.toHaveBeenCalled();
		});

		test("cp routes team to home and home to team", async () => {
			for (const [source, destination, sourceWorkspace, destinationWorkspace] of [
				[teamPath, homePath, "current", "personal"],
				[homePath, teamPath, "personal", "current"],
			]) {
				const runner = create_runner(teamPath);
				const result = await runner.shell.exec(`cd ${source}; cp -n a.txt ${destination}/dest`);
				expect(result).toMatchObject({ exitCode: 0, stderr: "" });
				expect(runner.runMutation).toHaveBeenNthCalledWith(
					1,
					internal.files_transfer.start_for_agent,
					expect.objectContaining({
						sourceWorkspace,
						destinationWorkspace,
						conflictPolicy: {
							file: "skip",
							folder: "merge",
						},
					}),
				);
			}
		});

		test.each(["cp", "mv"] as const)("%s keeps home-only operands on the personal root", async (command) => {
			const runner = create_runner(teamPath);
			const result = await runner.shell.exec(`cd ${homePath}; ${command} a.txt dest`);
			expect(result).toMatchObject({ exitCode: 0, stderr: "" });
			expect(runner.runMutation).toHaveBeenNthCalledWith(
				1,
				internal.files_transfer.start_for_agent,
				expect.objectContaining({
					sourceWorkspace: "personal",
					destinationWorkspace: "personal",
					sources: [{ kind: "saved", id: "personal:/a.txt" }],
					targetParent: { kind: "saved", id: "personal:/dest" },
				}),
			);
			expect(result.stdout).toContain("Review in Files.");
			expect(runner.reset).not.toHaveBeenCalled();
		});

		test.each(["cp -Rn", "mv -Tf"])("%s keeps same-home routing and flags", async (command) => {
			const runner = create_runner();
			expect(await runner.shell.exec(`${command} source ${homePath}/dest`)).toMatchObject({ exitCode: 0, stderr: "" });
			expect(runner.runMutation).toHaveBeenNthCalledWith(
				1,
				internal.files_transfer.start_for_agent,
				expect.objectContaining({
					sourceWorkspace: "current",
					destinationWorkspace: "current",
					conflictPolicy: command.startsWith("cp")
						? { file: "skip", folder: "merge" }
						: { file: "replace", folder: "replace_empty" },
				}),
			);
			expect(runner.reset).toHaveBeenCalledTimes(1);
		});

		test("cp refuses mixed source roots before starting", async () => {
			for (const sources of [`a.txt ${homePath}/b.txt`, `${homePath}/a.txt b.txt`]) {
				const runner = create_runner(teamPath);
				const result = await runner.shell.exec(`cp ${sources} dest`);
				expect(result).toMatchObject({ exitCode: 1, stdout: "" });
				expect(result.stderr).toContain("all sources must be in one workspace");
				expect(runner.runMutation).not.toHaveBeenCalled();
			}
		});

		test.each([teamPath, homePath])("copy finds missing parents in destination %s", async (destinationPath) => {
			const runner = create_runner(teamPath);
			const sourcePath = destinationPath === teamPath ? homePath : teamPath;
			const result = await runner.shell.exec(`cp ${sourcePath}/a.txt ${destinationPath}/dest/new/nested/copy.txt`);
			expect(result).toMatchObject({ exitCode: 0, stderr: "" });
			expect(runner.runMutation).toHaveBeenNthCalledWith(
				1,
				internal.files_transfer.start_for_agent,
				expect.objectContaining({
					targetParent: { kind: "saved", id: destinationPath === teamPath ? "/dest" : "personal:/dest" },
					targetPath: "/dest",
					targetName: "copy.txt",
					missingParentNames: ["new", "nested"],
				}),
			);
		});

		test.each([teamPath, homePath])(
			"copy routes a binary with a quoted path from %s without reading bytes",
			async (sourcePath) => {
				const runner = create_runner(teamPath);
				const sourceEntries = sourcePath === teamPath ? runner.entries : runner.personalEntries;
				const source = sourceEntries.get("/a.txt")!;
				sourceEntries.set("/-café image.png", {
					...source,
					path: "/-café image.png",
					name: "-café image.png",
					textKind: null,
					assetId: "asset_1" as Id<"files_r2_assets">,
				});
				const sourceFs = sourcePath === teamPath ? runner.dbFilesRoots.app.fs : runner.dbFilesRoots.personal!.fs;
				const read = vi.spyOn(sourceFs, "readFileBuffer");
				const destinationPath = sourcePath === teamPath ? homePath : teamPath;
				const result = await runner.shell.exec(
					`cd ${sourcePath}; cp -- './-café image.png' '${destinationPath}/dest/../dest/Copy Image.png'`,
				);
				expect(result).toMatchObject({ exitCode: 0, stderr: "" });
				expect(runner.runMutation).toHaveBeenNthCalledWith(
					1,
					internal.files_transfer.start_for_agent,
					expect.objectContaining({ sources: [source.target], targetPath: "/dest", targetName: "Copy Image.png" }),
				);
				expect(read).not.toHaveBeenCalled();
			},
		);

		test.each([teamPath, homePath])("scratch dispatch stays separate from %s", async (rootPath) => {
			const runner = create_runner(teamPath);
			const rootFs = rootPath === teamPath ? runner.dbFilesRoots.app.fs : runner.dbFilesRoots.personal!.fs;
			vi.spyOn(rootFs, "readFileBuffer").mockResolvedValue(new TextEncoder().encode("app text\n"));
			expect(await runner.shell.exec(`cp ${rootPath}/a.txt /tmp/output.txt`)).toMatchObject({
				exitCode: 0,
				stderr: "",
			});
			expect(await runner.scratch.readFile("/tmp/output.txt")).toBe("app text\n");
			expect(await runner.shell.exec(`cp /tmp/input.txt ${rootPath}/copy.txt`)).toMatchObject({
				exitCode: 1,
				stderr: expect.stringContaining("only app files can be copied into the app tree"),
			});
			for (const operands of [`${rootPath}/a.txt /tmp/moved.txt`, `/tmp/input.txt ${rootPath}/moved.txt`])
				expect(await runner.shell.exec(`mv ${operands}`)).toMatchObject({ exitCode: 1 });
			expect(await runner.scratch.readFile("/tmp/input.txt")).toBe("scratch\n");
			expect(runner.runMutation).not.toHaveBeenCalled();
		});

		test("keeps native scratch copy flags, bytes, directory targets, and moves from a personal cwd", async () => {
			const runner = create_runner(teamPath);
			const bytes = new Uint8Array([0, 127, 128, 255]);
			await runner.scratch.writeFile("/tmp/-source.bin", bytes);
			await runner.scratch.mkdir("/tmp/dest");
			expect(await runner.shell.exec(`cd ${homePath}; cp -pv -- /tmp/-source.bin /tmp/dest`)).toMatchObject({
				exitCode: 0,
				stderr: "",
				stdout: "'/tmp/-source.bin' -> '/tmp/dest/-source.bin'\n",
			});
			expect(await runner.scratch.readFileBuffer("/tmp/dest/-source.bin")).toEqual(bytes);
			expect(await runner.shell.exec("cp -nv /tmp/input.txt /tmp/dest/-source.bin")).toMatchObject({
				exitCode: 0,
				stdout: "",
				stderr: "",
			});
			expect(await runner.scratch.readFileBuffer("/tmp/dest/-source.bin")).toEqual(bytes);
			expect(await runner.shell.exec("cp -R /tmp/dest /tmp/copied && mv /tmp/copied /tmp/moved")).toMatchObject({
				exitCode: 0,
				stderr: "",
			});
			expect(await runner.scratch.readFileBuffer("/tmp/moved/-source.bin")).toEqual(bytes);
			expect(await runner.scratch.exists("/tmp/copied")).toBe(false);
			expect(runner.runMutation).not.toHaveBeenCalled();
		});

		test("personal text copies keep scratch directory and no-clobber behavior", async () => {
			const runner = create_runner(teamPath);
			const read = vi
				.spyOn(runner.dbFilesRoots.personal!.fs, "readFileBuffer")
				.mockResolvedValue(new TextEncoder().encode("personal\n"));
			expect(await runner.shell.exec(`cp ${homePath}/a.txt /tmp`)).toMatchObject({ exitCode: 0, stderr: "" });
			expect(await runner.scratch.readFile("/tmp/a.txt")).toBe("personal\n");
			read.mockClear();
			expect(await runner.shell.exec(`cp -n ${homePath}/b.txt /tmp/a.txt`)).toMatchObject({ exitCode: 0, stderr: "" });
			expect(read).not.toHaveBeenCalled();
			expect(await runner.scratch.readFile("/tmp/a.txt")).toBe("personal\n");
			expect(runner.runMutation).not.toHaveBeenCalled();
		});

		test("unreadable personal copies name the personal source and create no scratch output", async () => {
			const runner = create_runner(teamPath);
			vi.spyOn(runner.dbFilesRoots.personal!.fs, "readFileBuffer").mockRejectedValue(
				new bash_DbFilesContentUnavailableError({
					shellPath: `${homePath}/a.txt`,
					contentType: "application/pdf",
				}),
			);
			const result = await runner.shell.exec(`cp ${homePath}/a.txt /tmp/output.pdf`);
			expect(result).toMatchObject({ exitCode: 1, stdout: "" });
			expect(result.stderr).toContain("Bash can read editable text files only");
			expect(result.stderr).toContain(`${homePath}/a.txt.md`);
			expect(result.stderr).not.toContain(teamPath);
			expect(await runner.scratch.exists("/tmp/output.pdf")).toBe(false);
		});

		test.each(["cp", "mv"] as const)("%s refuses personal app writes in Ask mode", async (command) => {
			const runner = create_runner(teamPath, false);
			expect(await runner.shell.exec(`cd ${homePath}; ${command} a.txt dest`)).toMatchObject({
				exitCode: 1,
				stderr: expect.stringContaining("app file writes require Agent mode"),
			});
			expect(runner.runMutation).not.toHaveBeenCalled();
		});

		test.each(["cp", "mv"] as const)(
			"%s refuses unsupported personal flags and mixed scratch sources before writing",
			async (command) => {
				const runner = create_runner(teamPath);
				expect(await runner.shell.exec(`${command} -v ${homePath}/a.txt /tmp/output.txt`)).toMatchObject({
					exitCode: 2,
				});
				expect(await runner.shell.exec(`${command} /tmp/input.txt ${homePath}/a.txt /tmp`)).toMatchObject({
					exitCode: 1,
				});
				expect(await runner.scratch.readFile("/tmp/input.txt")).toBe("scratch\n");
				expect(await runner.scratch.exists("/tmp/a.txt")).toBe(false);
				expect(await runner.scratch.exists("/tmp/output.txt")).toBe(false);
				expect(runner.runMutation).not.toHaveBeenCalled();
			},
		);
	});

	test("starts one transfer for several operands and waits for usable output", async () => {
		const runner = create_runner();
		expect(await runner.run("cp", ["a.txt", "b.txt", "dest"])).toMatchObject({ exitCode: 0, stderr: "" });
		expect(runner.runMutation).toHaveBeenCalledWith(
			internal.files_transfer.start_for_agent,
			expect.objectContaining({
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				invocation: { id: runner.transferContext.invocationId, commandNumber: 4 },
				sources: [
					{ kind: "saved", id: "/a.txt" },
					{ kind: "saved", id: "/b.txt" },
				],
				targetParent: { kind: "saved", id: "/dest" },
				targetName: null,
				conflictPolicy: { file: "replace", folder: "merge" },
			}),
		);
		expect(runner.runQuery).toHaveBeenCalledTimes(1);
		expect(runner.reset).toHaveBeenCalledTimes(1);
	});

	test("recursive no-clobber merges folders and skips occupied file leaves", async () => {
		const runner = create_runner();
		await runner.run("cp", ["-Rn", "source", "dest"]);
		expect(runner.runMutation).toHaveBeenCalledWith(
			internal.files_transfer.start_for_agent,
			expect.objectContaining({
				conflictPolicy: { file: "skip", folder: "merge" },
			}),
		);
	});

	test.each([
		["-T", "error"],
		["-Tf", "replace_empty"],
	])("move %s has folder policy %s", async (flag, policy) => {
		const runner = create_runner();
		await runner.run("mv", [flag!, "source", "dest"]);
		expect(runner.runMutation).toHaveBeenCalledWith(
			internal.files_transfer.start_for_agent,
			expect.objectContaining({
				targetParent: { kind: "root" },
				targetName: "dest",
				conflictPolicy: expect.objectContaining({ folder: policy }),
			}),
		);
	});

	test("a job stop ends the copy as a user stop with 143", async () => {
		const runner = create_runner();
		runner.runQuery.mockImplementation(async () => {
			runner.transferContext.abort(bash_ABORT_REASON_STOPPED);
			return { activity: { status: "running" } };
		});
		runner.runMutation.mockImplementation(async (ref) =>
			getFunctionName(ref) === "files_transfer:stop_for_agent"
				? { _yay: null }
				: { _yay: { runId: runner.runId, activityId: runner.activityId } },
		);
		expect(await runner.run("cp", ["a.txt", "copy.txt"])).toMatchObject({
			exitCode: 143,
			stderr: expect.stringContaining("transfer stopped"),
		});
		expect(runner.runMutation).toHaveBeenLastCalledWith(
			internal.files_transfer.stop_for_agent,
			expect.objectContaining({ reason: "user", runId: runner.runId }),
		);
	});

	test("returns 143 before starting when the job was already stopped", async () => {
		const runner = create_runner();
		runner.transferContext.abort(bash_ABORT_REASON_STOPPED);
		expect(await runner.run("cp", ["a.txt", "copy.txt"])).toMatchObject({ exitCode: 143 });
		expect(runner.runMutation).not.toHaveBeenCalled();
	});

	test("a job waits for a busy lane without charging a start, then starts once", async () => {
		vi.useFakeTimers();
		const runner = create_runner();
		runner.transferContext.jobId = "job_1" as Id<"ai_chat_bash_invocations">;
		let laneChecks = 0;
		runner.runQuery.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_transfer:get_current_activity_for_agent") {
				laneChecks += 1;
				return laneChecks < 3 ? { activityId: runner.activityId, status: "running" } : null;
			}
			return {
				runId: runner.runId,
				activity: { _id: runner.activityId, status: "succeeded", progress: { completed: 1, skipped: 0, failed: 0 } },
			};
		});
		const pending = runner.run("cp", ["a.txt", "copy.txt"]);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(await pending).toMatchObject({ exitCode: 0 });
		expect(laneChecks).toBe(3);
		expect(runner.runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
			"files_transfer:start_for_agent",
			"files_transfer:seal_for_agent",
		]);
	});

	test("a Stop during the lane wait never starts a copy", async () => {
		vi.useFakeTimers();
		const runner = create_runner();
		runner.transferContext.jobId = "job_1" as Id<"ai_chat_bash_invocations">;
		let laneChecks = 0;
		// The lane stays busy, so the wait keeps polling. The Stop lands between two polls.
		runner.runQuery.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_transfer:get_current_activity_for_agent") {
				laneChecks += 1;
				if (laneChecks === 2) runner.transferContext.abort(bash_ABORT_REASON_STOPPED);
				return { activityId: runner.activityId, status: "running" };
			}
			return {
				runId: runner.runId,
				activity: { _id: runner.activityId, status: "succeeded", progress: { completed: 1, skipped: 0, failed: 0 } },
			};
		});
		const pending = runner.run("cp", ["a.txt", "copy.txt"]);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(await pending).toMatchObject({ exitCode: 143 });
		expect(runner.runMutation).not.toHaveBeenCalled();
	});

	test("a job gives up the lane wait after 60 s and lets the start decide", async () => {
		vi.useFakeTimers();
		const runner = create_runner();
		runner.transferContext.jobId = "job_1" as Id<"ai_chat_bash_invocations">;
		// The lane never frees, so the wait runs out its 60 s and `start_for_agent` answers `busy`.
		// That answer is final: the command fails instead of waiting again.
		let laneChecks = 0;
		runner.runQuery.mockImplementation(async () => {
			laneChecks += 1;
			return { activityId: runner.activityId, status: "running" };
		});
		runner.runMutation.mockResolvedValue({
			_nay: { name: "nay", message: "another transfer is running", data: { activityId: runner.activityId } },
		});
		const pending = runner.run("cp", ["a.txt", "copy.txt"]);
		await vi.advanceTimersByTimeAsync(61_000);
		expect(await pending).toMatchObject({
			exitCode: 1,
			stderr: expect.stringContaining("another transfer is running"),
		});
		// It really waited the whole minute at one poll every two seconds, instead of giving up early.
		expect(laneChecks).toBeGreaterThanOrEqual(25);
		expect(runner.runMutation).toHaveBeenCalledTimes(1);
	});

	test("a job gives up the lane wait at once on a transfer awaiting input", async () => {
		const runner = create_runner();
		runner.transferContext.jobId = "job_1" as Id<"ai_chat_bash_invocations">;
		runner.runQuery.mockResolvedValue({ activityId: runner.activityId, status: "awaiting_input" });
		expect(await runner.run("cp", ["a.txt", "copy.txt"])).toMatchObject({
			exitCode: 1,
			stderr: expect.stringContaining("waiting for input"),
		});
		expect(runner.runMutation).not.toHaveBeenCalled();
	});

	test("confirms Stop before returning timeout and allows the shell to continue", async () => {
		vi.useFakeTimers();
		const runner = create_runner();
		runner.runQuery.mockImplementation(async () => {
			vi.setSystemTime(runner.transferContext.deadlineAt);
			return { activity: { status: "running" } };
		});
		runner.runMutation.mockImplementation(async (ref) =>
			getFunctionName(ref) === "files_transfer:stop_for_agent"
				? { _yay: null }
				: { _yay: { runId: runner.runId, activityId: runner.activityId } },
		);
		expect(await runner.run("cp", ["a.txt", "copy.txt"])).toMatchObject({ exitCode: 124 });
		expect(runner.runMutation).toHaveBeenLastCalledWith(
			internal.files_transfer.stop_for_agent,
			expect.objectContaining({ reason: "timeout", runId: runner.runId }),
		);
		expect(runner.transferContext.abort).not.toHaveBeenCalled();
	});

	test("aborts later shell writes when Stop cannot be confirmed", async () => {
		vi.useFakeTimers();
		const runner = create_runner();
		runner.runQuery.mockImplementation(async () => {
			vi.setSystemTime(runner.transferContext.deadlineAt);
			return { activity: { status: "running" } };
		});
		runner.runMutation.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_transfer:stop_for_agent") throw new Error("Lost Stop reply");
			return { _yay: { runId: runner.runId, activityId: runner.activityId } };
		});
		await expect(runner.run("cp", ["a.txt", "copy.txt"])).rejects.toThrow("Stop could not be confirmed");
		expect(runner.transferContext.signal.aborted).toBe(true);
	});

	test("aborts later writes after a lost start reply", async () => {
		const runner = create_runner();
		runner.runMutation.mockRejectedValue(new Error("Lost start reply"));
		await expect(runner.run("cp", ["a.txt", "copy.txt"])).rejects.toThrow("Lost start reply");
		expect(runner.transferContext.signal.aborted).toBe(true);
	});

	test("returns timeout before starting when the shared deadline has passed", async () => {
		const runner = create_runner();
		runner.transferContext.deadlineAt = Date.now() - 1;
		expect(await runner.run("cp", ["a.txt", "copy.txt"])).toMatchObject({ exitCode: 124 });
		expect(runner.runMutation).not.toHaveBeenCalled();
		expect(runner.transferContext.abort).not.toHaveBeenCalled();
	});
});
