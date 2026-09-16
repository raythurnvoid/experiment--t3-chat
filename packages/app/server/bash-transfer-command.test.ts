import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { CommandContext } from "just-bash/browser";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { internal } from "../convex/_generated/api.js";
import {
	bash_ABORT_REASON_STOPPED,
	bash_DbFilesFs,
	bash_parse_cp_mv_operands,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_transfer_command_run } from "./bash-transfer-command.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function create_runner() {
	const currentWorkspacePath = "/home/cloud-usr/w/personal/home";
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
		allowDbFilesMkdir: true,
		ctxData: {
			organizationId: "organization_1" as Id<"organizations">,
			workspaceId: "workspace_1" as Id<"organizations_workspaces">,
			organizationName: "personal",
			workspaceName: "home",
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
		externalMounts: { currentWorkspacePath: "/.mounts", mounts: new Map() },
		plugins: { currentWorkspacePath: "/.plugins", mounts: new Map() },
	};
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
	return { run, runMutation, runQuery, runId, activityId, entries, transferContext, reset };
}

describe("bash_transfer_command_run", () => {
	test("starts one transfer for several operands and waits for usable output", async () => {
		const runner = create_runner();
		expect(await runner.run("cp", ["a.txt", "b.txt", "dest"])).toMatchObject({ exitCode: 0, stderr: "" });
		expect(runner.runMutation).toHaveBeenCalledWith(
			internal.files_transfer.start_for_agent,
			expect.objectContaining({
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
		expect(runner.runMutation).toHaveBeenCalledTimes(1);
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
