import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ai_chat_files_patch_thread_tmp_files_Args } from "../convex/ai_chat_files.ts";
import type { bash_ReviewScratch } from "../convex/bash.ts";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { files_nodes_db_create_node_recursively_at_path } from "../convex/files_nodes.ts";
import { files_nodes_db_insert_file_content_docs } from "../convex/files_nodes_content.ts";
import { r2 } from "../convex/r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_ROOT_ID, files_guess_content_type_from_name } from "../shared/files.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { bash_run_job } from "./bash.ts";
import { bash_COMMAND_EXIT_USAGE, bash_DbFilesFs, bash_READ_INLINE_MAX_BYTES } from "./bash-utils.ts";
import { ai_chat_tool_create_set_file_metadata } from "./server-ai-tools.ts";
import {
	test_db_files_mount,
	function_name_of,
	test_r2_objects,
	readme_seed_content,
	default_organization_files,
	big_md_file,
	create_bash_runner,
	get_shell,
	get_seeded_node,
	get_seeded_node_id,
	job_row,
	get_private_entry,
	upsert_pending_update_for_test,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	test("runs pwd and persists cd across invocations", async () => {
		const { run, getCwd } = await create_bash_runner();

		const pwdResult = await run({ command: "pwd" });
		expect(pwdResult.stdout.trim()).toBe(test_db_files_mount);
		expect(pwdResult.metadata.cwd).toBe(test_db_files_mount);
		expect(getCwd()).toBe(test_db_files_mount);

		const cdResult = await run({ command: `cd ${test_db_files_mount}/docs` });
		expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
		expect(getCwd()).toBe(`${test_db_files_mount}/docs`);

		const nextPwdResult = await run({ command: "pwd" });
		expect(nextPwdResult.stdout.trim()).toBe(`${test_db_files_mount}/docs`);
	});

	test("sets HOME to the cloud user home", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "printf $HOME" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("/home/cloud-usr");
	});

	test("replays a completed Bash call without repeating scratch or private writes", async () => {
		const runner = await create_bash_runner();
		const command = "printf once >> /tmp/replay.txt; printf draft >> draft-replay.txt";
		const first = await runner.run({ command, toolCallId: "replay-write" });
		expect(first.metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-replay.txt");

		expect(await runner.run({ command, toolCallId: "replay-write" })).toEqual(first);
		expect((await runner.run({ command: "cat /tmp/replay.txt; cat draft-replay.txt" })).stdout).toBe("oncedraft");
		const unchanged = await get_private_entry(runner, "/draft-replay.txt");
		expect(unchanged.pendingUpdate).toEqual(draft.pendingUpdate);
		await expect(
			runner.run({ command: "printf changed >> /tmp/replay.txt", toolCallId: "replay-write" }),
		).rejects.toThrow("already has a different command");
		expect((await runner.run({ command: "cat /tmp/replay.txt" })).stdout).toBe("once");
	});

	test("reads a lost Bash begin reply without starting its interpreter", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		let lostReply = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const result = await mutate(ref, args);
			if (!lostReply && function_name_of(ref) === "ai_chat_files:begin_bash_invocation") {
				lostReply = true;
				throw new Error("Lost begin reply");
			}
			return result;
		});

		const result = await runner.run({ command: "printf once >> /tmp/lost-begin.txt", toolCallId: "lost-begin" });
		expect(lostReply).toBe(true);
		expect(result.metadata.exitCode).toBe(3);
		expect(result.stderr).toContain("still running");
		expect(
			runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "ai_chat_files:get_bash_invocation"),
		).toBe(true);
		expect((await runner.run({ command: "test -e /tmp/lost-begin.txt" })).metadata.exitCode).toBe(1);
		const replay = await runner.run({ command: "printf once >> /tmp/lost-begin.txt", toolCallId: "lost-begin" });
		expect(replay.metadata.exitCode).toBe(3);
		expect((await runner.run({ command: "test -e /tmp/lost-begin.txt" })).metadata.exitCode).toBe(1);
	});

	test("replays a saved Bash result after its finish reply is lost", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		let lostReply = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const result = await mutate(ref, args);
			if (!lostReply && function_name_of(ref) === "ai_chat_files:finish_bash_invocation") {
				lostReply = true;
				throw new Error("Lost finish reply");
			}
			return result;
		});

		await expect(
			runner.run({ command: "printf once >> /tmp/lost-finish.txt", toolCallId: "lost-finish" }),
		).rejects.toThrow("Lost finish reply");
		const replay = await runner.run({ command: "printf once >> /tmp/lost-finish.txt", toolCallId: "lost-finish" });
		expect(replay.metadata.exitCode).toBe(0);
		expect((await runner.run({ command: "cat /tmp/lost-finish.txt" })).stdout).toBe("once");
	});

	test("does not restart an interrupted Bash call with partial scratch writes", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		let interrupted = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			if (!interrupted && function_name_of(ref) === "ai_chat_files:finish_bash_invocation") {
				interrupted = true;
				throw new Error("Finish unavailable");
			}
			return await mutate(ref, args);
		});

		await expect(
			runner.run({ command: "printf once >> /tmp/interrupted.txt", toolCallId: "interrupted" }),
		).rejects.toThrow("Finish unavailable");
		const replay = await runner.run({ command: "printf once >> /tmp/interrupted.txt", toolCallId: "interrupted" });
		expect(replay.metadata.exitCode).toBe(1);
		expect(replay.stderr).toContain("was interrupted");
		expect((await runner.run({ command: "cat /tmp/interrupted.txt" })).stdout).toBe("once");
	});

	test.each([false, true])(
		"returns 124 when final scratch persistence passes the deadline (watchdog: %s)",
		async (watchdog) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const runner = await create_bash_runner();
				const mutate = runner.runMutation.getMockImplementation()!;
				runner.runMutation.mockImplementation(async (ref, args) => {
					const saved = await mutate(ref, args);
					if (function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files") {
						const invocation = await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").first());
						if (!invocation) throw new Error("Expected invocation");
						vi.setSystemTime(invocation.deadlineAt + 1);
						if (watchdog)
							await runner.t.mutation(internal.ai_chat_files.interrupt_bash_invocation, {
								invocationId: invocation._id,
							});
					}
					return saved;
				});

				const command = "printf once >> /tmp/late-persistence.txt";
				const completed = await runner.run({ command, toolCallId: "late-persistence" });
				expect(completed.metadata.exitCode).toBe(124);
				expect(completed.stderr).toContain("deadline");
				expect((await runner.run({ command, toolCallId: "late-persistence" })).metadata.exitCode).toBe(124);
				const stored = await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").first());
				expect(stored?.status).toBe("interrupted");
				expect((await runner.run({ command: "cat /tmp/late-persistence.txt" })).stdout).toBe("once");
			} finally {
				vi.useRealTimers();
			}
		},
	);

	test("repairs an interrupted finish whose cwd holds half a character", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const result = await mutate(ref, args);
			if (
				function_name_of(ref) === "ai_chat_files:finish_bash_invocation" &&
				result !== null &&
				typeof result === "object" &&
				"_yay" in result &&
				result._yay !== null &&
				typeof result._yay === "object"
			) {
				return { _yay: { ...result._yay, result: null, deadlineAt: Date.now() - 1 } };
			}
			return result;
		});

		// `cd` into a `/tmp` name that holds half a character. The usual return goes through
		// `bash_response`, but this branch rebuilds `title` from the raw cwd after finish answers
		// with no stored result. Convex then refuses the whole return.
		const completed = await runner.run({ command: "mkdir /tmp/$(printf '\\ud83c'); cd /tmp/$(printf '\\ud83c')" });
		expect(completed.metadata.exitCode).toBe(124);
		expect(completed.title.startsWith("exit 124 · /tmp/")).toBe(true);
		expect(completed.title.isWellFormed()).toBe(true);
	});

	test.each([false, true])("refuses an old HTTP run after rejoin (lost begin reply: %s)", async (lostReply) => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "bash-run-team", workspaceName: "home" }),
		);
		const member = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		const invite = {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: member.userId,
		};
		expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
			_yay: null,
		});
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected invited membership");
		const oldRun = await create_bash_runner({
			shared: { t, seeded: { ...owner, userId: member.userId, membershipId: membership._id } },
		});
		expect(
			await asMember.mutation(api.organizations.remove_user_from_organization, {
				organizationId: owner.organizationId,
				userIdToRemove: member.userId,
			}),
		).toEqual({ _yay: null });
		expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
			_yay: null,
		});
		const rejoined = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
				)
				.unique(),
		);
		if (!rejoined) throw new Error("Expected rejoined membership");
		const currentRun = await create_bash_runner({
			threadId: oldRun.threadId,
			shared: { t, seeded: { ...owner, userId: member.userId, membershipId: rejoined._id } },
		});
		expect((await currentRun.run({ command: "printf current", toolCallId: "current-call" })).stdout).toBe("current");
		const before = await t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").collect());
		await expect(
			oldRun.run({ command: "printf stale > /tmp/stale.txt", toolCallId: "old-new-call", shellName: "stale" }),
		).rejects.toThrow("Unauthorized");
		if (lostReply) {
			const mutate = oldRun.runMutation.getMockImplementation()!;
			oldRun.runMutation.mockImplementation(async (ref, args) => {
				if (function_name_of(ref) === "ai_chat_files:begin_bash_invocation") throw new Error("Lost begin reply");
				return await mutate(ref, args);
			});
		}
		await expect(oldRun.run({ command: "printf current", toolCallId: "current-call" })).rejects.toThrow("Unauthorized");
		expect(await t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").collect())).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("ai_chat_bash_shells").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("ai_chat_files").collect())).toEqual([]);
	});

	test.each([
		{ rejoin: false, persist: "scratch" },
		{ rejoin: true, persist: "scratch" },
		{ rejoin: false, persist: "result" },
		{ rejoin: true, persist: "result" },
	])("refuses late $persist writes after membership removal (rejoin: $rejoin)", async ({ rejoin, persist }) => {
		const test_db_files_mount = "/home/cloud-usr/w/bash-team/home";
		const t = test_convex();
		const owner = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "bash-team", workspaceName: "home" }),
		);
		const member = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		const inviteArgs = {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: member.userId,
		};
		expect(
			(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, inviteArgs))._nay,
		).toBeUndefined();
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected invited membership");
		const runner = await create_bash_runner({
			shared: { t, seeded: { ...owner, userId: member.userId, membershipId: membership._id } },
		});
		expect((await runner.run({ command: "printf before > /tmp/member.txt" })).metadata.exitCode).toBe(0);
		const mutate = runner.runMutation.getMockImplementation()!;
		let removal: Promise<void> | undefined;
		const writes: Promise<unknown>[] = [];
		runner.runMutation.mockImplementation(async (ref, args) => {
			const name = function_name_of(ref);
			const isFinalWrite =
				persist === "result"
					? name === "ai_chat_files:finish_bash_invocation"
					: name === "ai_chat_files:patch_thread_tmp_files" || name === "ai_chat:save_shell";
			if (!isFinalWrite) return await mutate(ref, args);
			removal ??= (async () => {
				expect(
					(
						await asMember.mutation(api.organizations.remove_user_from_organization, {
							organizationId: owner.organizationId,
							userIdToRemove: member.userId,
						})
					)._nay,
				).toBeUndefined();
				if (rejoin)
					expect(
						(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, inviteArgs))._nay,
					).toBeUndefined();
			})();
			await removal;
			const write = mutate(ref, args);
			writes.push(write);
			return await write;
		});

		const command = persist === "result" ? "printf ready" : "printf late > /tmp/member.txt; cd /tmp";
		const outcome = await runner.run({ command, toolCallId: "removed-member" }).catch((error: unknown) => error);
		const settled = await Promise.allSettled(writes);
		expect(outcome).toBeInstanceOf(Error);
		expect(settled).toHaveLength(persist === "result" ? 1 : 2);
		if (persist === "scratch") expect(settled.every((write) => write.status === "rejected")).toBe(true);
		const invocation = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_bash_invocations")
				.withIndex("by_thread_toolCall", (q) => q.eq("threadId", runner.threadId).eq("toolCallId", "removed-member"))
				.unique(),
		);
		expect(invocation?.status).toBe("interrupted");
		expect(invocation?.result).toBeUndefined();
		// Read stored bytes directly: the removed member cannot use the scratch read door.
		const content = await t.run(async (ctx) => {
			const file = await ctx.db
				.query("ai_chat_files")
				.withIndex("by_thread_path", (q) => q.eq("threadId", runner.threadId).eq("path", "/member.txt"))
				.first();
			if (!file) throw new Error("Expected scratch file");
			return await ctx.db
				.query("ai_chat_files_content")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", file._id))
				.first();
		});
		expect(new TextDecoder().decode(content!.bytes)).toBe("before");
		expect((await get_shell({ t, threadId: runner.threadId }))?.cwd).toBe(test_db_files_mount);
		if (rejoin) {
			const rejoined = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
					)
					.unique(),
			);
			if (!rejoined) throw new Error("Expected rejoined membership");
			const freshRun = await create_bash_runner({
				threadId: runner.threadId,
				shared: { t, seeded: { ...owner, userId: member.userId, membershipId: rejoined._id } },
			});
			expect((await freshRun.run({ command: "cat /tmp/member.txt" })).stdout).toBe("before");
			expect((await freshRun.run({ command: "printf after > /tmp/member.txt; cd /tmp" })).metadata.exitCode).toBe(0);
			expect((await freshRun.run({ command: "cat /tmp/member.txt" })).stdout).toBe("after");
		}
	});

	test("guides unknown commands toward supported bash commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "notrealcmd" });
		const swallowed = await run({ command: "notrealcmd 2>&1 || true" });
		const compound = await run({ command: "notrealcmd; true" });

		expect(result.metadata.exitCode).toBe(127);
		expect(result.stderr).toContain("command not found");
		expect(result.stderr).toContain("run 'help' to list available commands");
		expect(result.stderr).toContain("use search/grep for content and find/ls for paths");
		expect(swallowed.metadata.exitCode).toBe(0);
		expect(swallowed.stdout).toContain("command not found");
		expect(swallowed.stderr).toContain("run 'help' to list available commands");
		expect(compound.metadata.exitCode).toBe(0);
		expect(compound.stderr).toContain("command not found");
		expect(compound.stderr).toContain("run 'help' to list available commands");
	});

	test("runs strict-mode boilerplate", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "set -euo pipefail\nprintf hi > /tmp/a.txt\ncat /tmp/a.txt" });

		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("hi");

		// The three options are honored, not just accepted: errexit stops the script, nounset
		// refuses the unset read, and pipefail reports the failing side of the pipe.
		const errexit = await run({ command: "set -e\nfalse\necho reached" });
		expect(errexit.metadata.exitCode).toBe(1);
		expect(errexit.stdout).not.toContain("reached");

		const nounset = await run({ command: 'set +e\nset -u\necho "$NEVER_SET_VAR"' });
		expect(nounset.metadata.exitCode).toBe(1);
		expect(nounset.stderr).toContain("unbound variable");

		const pipefail = await run({ command: "set +u\nset -o pipefail\nfalse | cat\necho code=$?" });
		expect(pipefail.stdout).toContain("code=1");
	});

	test("a timeout keeps the earlier output and drops the output of the command it stopped", async () => {
		const { run } = await create_bash_runner();

		// The engine stops a timed-out command by aborting it, and after that abort it refuses to
		// collect any more output. So the statements that already ran must keep theirs, while the
		// command that was stopped reports only exit 124.
		const result = await run({ command: "printf 'kept\\n'; timeout 1 sleep 5; printf 'code=%s\\n' \"$?\"" });

		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("kept\ncode=124\n");
	});

	test("seq past the loop-iteration limit says so instead of returning a short sequence", async () => {
		const { run } = await create_bash_runner();

		// seq counts against the shell's loop-iteration limit. An older engine stopped at its own
		// hard-coded cap and returned the shorter sequence with exit 0, which let a model read a
		// truncated list as the whole answer.
		const result = await run({ command: "seq 1 20000 | tail -n 1" });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("seq: iteration limit exceeded (10000)");
	});

	test("restores app-command guidance that the shell swallowed", async () => {
		const { run } = await create_bash_runner();

		// `2>/dev/null` drops the `Try:` line and the pipe turns exit 2 into head's exit 0, so
		// without the restore the model sees an empty successful result and reports "not found".
		const blinded = await run({
			command: `find ${test_db_files_mount} -type f -iname 'readme*' 2>/dev/null | head -n 5`,
		});

		expect(blinded.metadata.exitCode).toBe(0);
		expect(blinded.stdout).toBe("");
		expect(blinded.stderr).toContain("find exited 2 and its stderr was discarded");
		expect(blinded.stderr).toContain("-name/-iname use name search for app files");
		expect(blinded.stderr).toContain("or use words like `readme`");
	});

	test("does not repeat app-command guidance for a path that holds half a character", async () => {
		const { run } = await create_bash_runner();

		// The guidance is recorded as the command printed it, so the search for it has to run against
		// the same raw text. Repairing the output before this point made the search miss: the guidance
		// was printed a second time, and raw, so the call still sent Convex half a character.
		const broken = await run({ command: `cat "$(printf 'a\\ud83c')/f.md"` });

		expect(broken.metadata.exitCode).toBe(1);
		expect(broken.stderr).toContain("No such file or directory");
		expect(broken.stderr).not.toContain("its stderr was discarded");
		expect(broken.stderr.isWellFormed()).toBe(true);
	});

	test("does not repeat app-command guidance that is already visible", async () => {
		const { run } = await create_bash_runner();

		const plain = await run({ command: `find ${test_db_files_mount} -type f -iname 'readme*'` });
		const merged = await run({ command: `find ${test_db_files_mount} -type f -iname 'readme*' 2>&1 || true` });

		expect(plain.metadata.exitCode).toBe(2);
		expect(plain.stderr).toContain("-name/-iname use name search for app files");
		expect(plain.stderr).not.toContain("its stderr was discarded");
		// `2>&1` keeps the guidance, just on stdout, so it must not be printed a second time.
		expect(merged.stdout).toContain("-name/-iname use name search for app files");
		expect(merged.stderr).not.toContain("its stderr was discarded");
	});

	test("does not treat file content as an unknown command", async () => {
		const literalPath = "/docs/command-not-found.md";
		const { run } = await create_bash_runner({
			extraFiles: [{ path: literalPath, content: "example: command not found\n" }],
		});

		const catResult = await run({ command: `cat ${test_db_files_mount}${literalPath}` });
		const grepResult = await run({ command: `grep "command not found" ${test_db_files_mount}${literalPath}` });

		expect(catResult.stdout).toContain("example: command not found");
		expect(catResult.stderr).not.toContain("run 'help' to list available commands");
		expect(grepResult.stdout).toContain("example: command not found");
		expect(grepResult.stderr).not.toContain("run 'help' to list available commands");
	});

	test("reads markdown files through the chunk-backed file content query", async () => {
		const { run, runQuery, runAction, seeded } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/docs/readme.md` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(
			runQuery.mock.calls.some(
				([ref, queryArgs]) =>
					function_name_of(ref) === "files_nodes:read_file_content_from_chunks" &&
					queryArgs?.path === "/docs/readme.md" &&
					queryArgs?.userId === seeded.userId,
			),
		).toBe(true);
		expect(
			runAction.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
	});

	test("supports cat end-of-options marker for dash-leading operands", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [
				{ path: "/-dash.md", content: "dash file\n" },
				{ path: "/--help", content: "help file\n" },
			],
		});

		const dashFile = await run({ command: "cat -- -dash.md" });
		const stdin = await run({ command: "printf stdin-ok | cat -- -" });
		const helpFile = await run({ command: "cat -- --help" });

		expect(dashFile.metadata.exitCode).toBe(0);
		expect(dashFile.stdout).toBe("dash file\n");
		expect(stdin.metadata.exitCode).toBe(0);
		expect(stdin.stdout).toBe("stdin-ok");
		expect(helpFile.metadata.exitCode).toBe(0);
		expect(helpFile.stdout).toBe("help file\n");
	});

	test("delegates cat help to the built-in command", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "cat --help" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: cat [OPTION]... [FILE]...");
		expect(result.stderr).toBe("");
	});

	test("treats missing stdin as empty input for cat", async () => {
		const { run } = await create_bash_runner();

		const plain = await run({ command: "cat" });
		const numbered = await run({ command: "cat -n" });
		const explicitStdin = await run({ command: "cat -- -" });

		expect(plain.metadata.exitCode).toBe(0);
		expect(plain.stdout).toBe("");
		expect(numbered.metadata.exitCode).toBe(0);
		expect(numbered.stdout).toBe("");
		expect(explicitStdin.metadata.exitCode).toBe(0);
		expect(explicitStdin.stdout).toBe("");
	});

	test("does not fall back to full-content action when cat chunks are unavailable", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [{ path: "/docs/unmaterialized.md", content: "hidden fallback\n", materialized: false }],
		});

		const result = await run({ command: `cat ${test_db_files_mount}/docs/unmaterialized.md` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content is not available from materialized chunks");
		expect(result.stderr).toContain(`${test_db_files_mount}/docs/unmaterialized.md`);
		expect(
			runAction.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
	});

	test("caches markdown file content within one bash invocation", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({
			command: `cat ${test_db_files_mount}/docs/readme.md && cat ${test_db_files_mount}/docs/readme.md`,
		});
		const readCalls = runQuery.mock.calls.filter(
			([ref, queryArgs]) =>
				function_name_of(ref) === "files_nodes:read_file_content_from_chunks" && queryArgs?.path === "/docs/readme.md",
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.split("# Readme").length - 1).toBe(2);
		expect(readCalls).toHaveLength(1);
	});

	test.each(["cat", "readFile", "getEntry"] as const)(
		"%s refuses cached data after a file grant ends",
		async (door) => {
			const test_db_files_mount = "/home/cloud-usr/w/cache-team/home";
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "cache-team", workspaceName: "home" }),
			);
			const owner = await create_bash_runner({ shared: { t, seeded }, extraFiles: default_organization_files });
			const nodeId = await get_seeded_node_id(owner, "/docs/readme.md");
			const member = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "cache-member" });
				await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: "personal", workspaceName: "home" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			const asOwner = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "cache-owner",
				external_id: seeded.userId,
				email: "cache-owner@test.local",
			});
			const share = {
				membershipId: seeded.membershipId,
				nodeId,
				principal: { kind: "user" as const, userId: member.userId },
			};
			expect(
				(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: seeded.membershipId, nodeId }))._nay,
			).toBeUndefined();
			expect(
				(await asOwner.mutation(api.files_sharing.set_node_share_grant, { ...share, level: "read" }))._nay,
			).toBeUndefined();
			const runner = await create_bash_runner({ shared: { t, seeded: { ...seeded, ...member } } });
			const revoke = async () => {
				expect((await asOwner.mutation(api.files_sharing.remove_node_share_grant, share))._nay).toBeUndefined();
			};
			if (door === "cat") {
				const query = runner.runQuery.getMockImplementation()!;
				let revoked = false;
				runner.runQuery.mockImplementation(async (ref, args) => {
					const result = await query(ref, args);
					if (!revoked && function_name_of(ref) === "files_nodes:read_file_content_from_chunks") {
						revoked = true;
						await revoke();
					}
					return result;
				});
				const result = await runner.run({
					command: `cat ${test_db_files_mount}/docs/readme.md; cat ${test_db_files_mount}/docs/readme.md`,
				});
				expect(revoked).toBe(true);
				expect(result.stdout).toBe(readme_seed_content);
				expect(result.metadata.exitCode).toBe(1);
			} else {
				const fs = new bash_DbFilesFs({
					ctx: runner.ctx,
					ctxData: runner.ctxData,
					currentWorkspacePath: test_db_files_mount,
					allowDbFilesMkdir: false,
				});
				if (door === "readFile") expect(await fs.readFile("/docs/readme.md")).toBe(readme_seed_content);
				else expect(await fs.getEntry("/docs/readme.md")).toMatchObject({ target: { kind: "saved", id: nodeId } });
				await revoke();
				if (door === "readFile") await expect(fs.readFile("/docs/readme.md")).rejects.toThrow("ENOENT");
				else expect(await fs.getEntry("/docs/readme.md")).toBeNull();
			}
			expect((await t.run((ctx) => ctx.db.get("organizations_workspaces_users", member.membershipId)))?.active).toBe(
				true,
			);
		},
	);

	test("cat does not serve stale cached content after a same-call mv", async () => {
		const runner = await create_bash_runner();

		// The mv vacates the old path mid-call, so the second cat must fail instead of
		// replaying the first cat's cached content.
		const chained = await runner.run({
			command: `cat ${test_db_files_mount}/docs/readme.md && mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/moved.md && cat ${test_db_files_mount}/docs/readme.md`,
		});
		expect(chained.metadata.exitCode).not.toBe(0);
		expect(chained.stderr).toContain("No such file or directory");
		// Only the first cat prints the content.
		expect(chained.stdout.split("# Readme").length - 1).toBe(1);

		// cat at the NEW path in the same call serves the moved content.
		const movedChain = await runner.run({
			command: `cat ${test_db_files_mount}/docs/tutorial.md && mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md && cat ${test_db_files_mount}/docs/guide.md`,
		});
		expect(movedChain.stderr).toBe("");
		expect(movedChain.metadata.exitCode).toBe(0);
		expect(movedChain.stdout.split("zeta").length - 1).toBe(2);
	});

	test("readers serve a non-collaborative file from its committed chunks", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/plain.md", content: "alpha\nbeta\ngamma\n", nonCollaborative: true }],
		});

		// Prove the seed really is non-collaborative, so the reads below cannot pass through a
		// Yjs document that should not exist.
		const seededNode = await get_seeded_node(runner, "/plain.md");
		expect(seededNode.collaborationEnabled).toBe(false);
		expect(seededNode.yjsSnapshotId).toBeNull();
		expect(seededNode.yjsLastSequenceId).toBeNull();

		const printed = await runner.run({ command: `cat ${test_db_files_mount}/plain.md` });
		expect(printed.stderr).toBe("");
		expect(printed.metadata.exitCode).toBe(0);
		expect(printed.stdout).toBe("alpha\nbeta\ngamma\n");

		const firstLines = await runner.run({ command: `head -n 2 ${test_db_files_mount}/plain.md` });
		expect(firstLines.stderr).toBe("");
		expect(firstLines.stdout).toBe("alpha\nbeta\n");

		const counted = await runner.run({ command: `wc -l ${test_db_files_mount}/plain.md` });
		expect(counted.stderr).toBe("");
		expect(counted.stdout.trim().startsWith("3")).toBe(true);
	});

	test("reads current app file byte size after an unsaved edit is created", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/fresh-size.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const dbFilesDoc = await get_seeded_node(runner, "/fresh-size.md");
		const dbFilesDocId = dbFilesDoc._id;

		const committedStat = await runner.run({ command: `stat -c %s ${test_db_files_mount}/fresh-size.md` });
		expect(committedStat.stderr).toBe("");
		expect(committedStat.metadata.exitCode).toBe(0);
		const committedSize = Number(committedStat.stdout.trim());
		expect(committedSize).toBeLessThan(bash_READ_INLINE_MAX_BYTES);

		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: dbFilesDocId },
			unstagedText: "pending text ".repeat(6000),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: dbFilesDocId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /fresh-size.md");
		}
		runner.runQuery.mockClear();

		const currentStat = await runner.run({ command: `stat -c %s ${test_db_files_mount}/fresh-size.md` });
		expect(currentStat.stderr).toBe("");
		expect(currentStat.metadata.exitCode).toBe(0);
		const currentSize = Number(currentStat.stdout.trim());

		expect(currentSize).toBe(pendingUpdate.size);
		expect(currentSize).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("uses pending update size metadata without reconstructing content", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/legacy-pending.md", content: "base\n", withRealYjsSnapshot: true }],
		});
		const dbFilesDoc = await get_seeded_node(runner, "/legacy-pending.md");
		const dbFilesDocId = dbFilesDoc._id;
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: dbFilesDocId },
			unstagedText: "pending body\n",
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: dbFilesDocId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /legacy-pending.md");
		}
		runner.runQuery.mockClear();
		runner.runAction.mockClear();

		const currentStat = await runner.run({ command: `stat -c %s ${test_db_files_mount}/legacy-pending.md` });
		expect(currentStat.stderr).toBe("");
		expect(currentStat.metadata.exitCode).toBe(0);
		const size = Number(currentStat.stdout.trim());

		expect(size).toBe(pendingUpdate.size);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
		expect(
			runner.runAction.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
	});

	test("pipes cat text output without corrupting Unicode", async () => {
		const unicodePath = "/docs/unicode.md";
		const content = "cafe\u0301 — snowman ☃\n";
		const { run } = await create_bash_runner({
			extraFiles: [{ path: unicodePath, content }],
		});

		const result = await run({ command: `cat ${test_db_files_mount}${unicodePath} | cat` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(content);
	});

	test("supports ls, find, and stat over db-files paths", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: `ls ${test_db_files_mount}/docs && find ${test_db_files_mount}/docs -maxdepth 1 -type f && stat ${test_db_files_mount}/docs/readme.md`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("readme.md");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("keeps valid ls operands when another operand is missing", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls ${test_db_files_mount}/docs ${test_db_files_mount}/missing` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs:`);
		expect(result.stdout).toContain("readme.md");
		expect(result.stderr).toContain(`ls: cannot access '${test_db_files_mount}/missing': No such file or directory`);
	});

	test("supports paginated ls with a continuation command", async () => {
		const runner = await create_bash_runner();
		const { run, runQuery } = runner;

		const result = await run({ command: `ls --limit 1 ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("nested/");
		expect(result.stdout).toContain("Next page:");
		expect(result.stdout).toMatch(new RegExp(`ls --limit 1 --cursor \\S+ ${test_db_files_mount}/docs`, "u"));
		expect(result.stderr).not.toContain("directory listing truncated");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					folderPath: "/docs",
					numItems: 1,
					position: { rangeStart: null, cursor: null, lastKey: null },
				}),
			]),
		);
	});

	test("resolves paginated ls path arguments from the current working directory", async () => {
		const runner = await create_bash_runner();
		const { run, runQuery } = runner;

		await run({ command: `cd ${test_db_files_mount}/docs` });
		const bareResult = await run({ command: "ls --limit 10" });
		const dotResult = await run({ command: "ls --limit 10 ." });
		const relativeResult = await run({ command: "ls --limit 10 nested" });

		expect(bareResult.metadata.exitCode).toBe(0);
		expect(bareResult.stdout).toContain("readme.md");
		expect(dotResult.metadata.exitCode).toBe(0);
		expect(dotResult.stdout).toContain("tutorial.md");
		expect(relativeResult.metadata.exitCode).toBe(0);
		expect(relativeResult.stdout).toContain("deep.md");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					folderPath: "/docs",
					numItems: 10,
					position: { rangeStart: null, cursor: null, lastKey: null },
				}),
				expect.objectContaining({
					folderPath: "/docs/nested",
					numItems: 10,
					position: { rangeStart: null, cursor: null, lastKey: null },
				}),
			]),
		);
	});

	test("delegates bare ls to the current scratch directory outside the current workspace path", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: "cd /tmp && printf hi > scratch.txt && ls" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("scratch.txt");
		expect(result.stdout).not.toContain("readme.md");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("keeps /tmp relative ls output outside the current workspace path", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: "cd /tmp && printf hi > relative-tmp.txt && ls relative-tmp.txt" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("relative-tmp.txt");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("reports unknown ls cursor ids with recovery guidance", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
	});

	test("resolves stored cursor ids through value_store with an explicit 24-hour TTL", async () => {
		const { run, runQuery, runMutation } = await create_bash_runner();

		const firstPage = await run({ command: `ls --limit 1 ${test_db_files_mount}/docs` });
		const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
		if (cursorId == null) {
			throw new Error("expected a cursor id in the first page stdout");
		}
		const rawCursor = runMutation.mock.calls
			.map(([ref, mutationArgs]) => (function_name_of(ref) === "value_store:put" ? mutationArgs.value : null))
			.find((value): value is string => typeof value === "string");
		if (rawCursor == null) {
			throw new Error("expected the first page cursor to be stored in value_store");
		}

		runQuery.mockClear();
		const secondPage = await run({ command: `ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs` });

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("readme.md");
		expect(runMutation).toHaveBeenCalledWith(internal.value_store.put, {
			value: rawCursor,
			ttl: 24 * 60 * 60 * 1000,
		});
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: cursorId });
		// The stored cursor holds each stream's position; the saved stream goes on from its own.
		const saved = (JSON.parse(rawCursor) as { streams: { kind: string; position: unknown }[] }).streams.find(
			(stream) => stream.kind === "saved",
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list_children_saved,
			expect.objectContaining({ folderPath: "/docs", position: saved!.position }),
		);
	});

	test("rejects a removed cursor even after it has been used", async () => {
		const { run, runQuery, t } = await create_bash_runner();

		const firstPage = await run({ command: `ls --limit 1 ${test_db_files_mount}/docs` });
		const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
		if (cursorId == null) {
			throw new Error("expected a cursor id in the first page stdout");
		}
		const secondPage = await run({ command: `ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs` });
		expect(secondPage.metadata.exitCode).toBe(0);
		await t.mutation(internal.value_store.remove, { id: cursorId as Id<"value_store"> });
		runQuery.mockClear();
		const removedPage = await run({ command: `ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs` });

		expect(removedPage.metadata.exitCode).toBe(1);
		expect(removedPage.stderr).toContain("expired, is unavailable, or was copied incorrectly");
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: cursorId });
	});

	test("rejects a cursor at its 24-hour expiry", async () => {
		const { run } = await create_bash_runner();
		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const firstPage = await run({ command: `ls --limit 1 ${test_db_files_mount}/docs` });
			const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
			if (cursorId == null) {
				throw new Error("expected a cursor id in the first page stdout");
			}
			dateNow.mockReturnValue(now + 24 * 60 * 60 * 1000);
			const expiredPage = await run({ command: `ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs` });

			expect(expiredPage.metadata.exitCode).toBe(1);
			expect(expiredPage.stderr).toContain("expired, is unavailable, or was copied incorrectly");
		} finally {
			dateNow.mockRestore();
		}
	});

	test("reports missing cursor ids with recovery guidance", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls --limit 1 --cursor missing ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stderr).toContain("cursor missing expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
	});

	test("supports multiple ls path operands with per-directory continuation commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: `ls --limit 1 ${test_db_files_mount}/docs ${test_db_files_mount} ${test_db_files_mount}/docs/readme.md`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(result.stdout).toContain(`${test_db_files_mount}:\ndocs/`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout.match(/Next page:/gu)).toHaveLength(2);
		const continuations = [...result.stdout.matchAll(/Next page: ls --limit 1 --cursor (\S+) (\S+)/gu)];
		expect(continuations.map((m) => m[2])).toEqual([`${test_db_files_mount}/docs`, test_db_files_mount]);
		expect(continuations[0][1]).not.toBe(continuations[1][1]);
	});

	test("supports mixed /tmp and app ls operands without a cursor", async () => {
		const { run } = await create_bash_runner();

		const tmpFirst = await run({
			command: `printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt /tmp/mixed-tmp-b.txt ${test_db_files_mount}/docs`,
		});
		const tmpAppTmp = await run({
			command: `printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt ${test_db_files_mount}/docs /tmp/mixed-tmp-b.txt`,
		});

		expect(tmpFirst.metadata.exitCode).toBe(0);
		expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-a.txt");
		expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-b.txt");
		expect(tmpFirst.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
			tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
		);
		expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt")).toBeLessThan(
			tmpFirst.stdout.indexOf(`${test_db_files_mount}/docs:`),
		);
		expect(tmpFirst.stderr).not.toContain("cannot mix app file paths");

		expect(tmpAppTmp.metadata.exitCode).toBe(0);
		expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-a.txt");
		expect(tmpAppTmp.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-b.txt");
		expect(tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
			tmpAppTmp.stdout.indexOf(`${test_db_files_mount}/docs:`),
		);
		expect(tmpAppTmp.stdout.indexOf(`${test_db_files_mount}/docs:`)).toBeLessThan(
			tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
		);
		expect(tmpAppTmp.stderr).not.toContain("cannot mix app file paths");
	});

	test("formats mixed /tmp and app ls directory sections consistently", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: `mkdir -p /tmp/mixed-ls-dir && printf hi > /tmp/mixed-ls-dir/tmp.txt && ls ${test_db_files_mount}/docs /tmp/mixed-ls-dir`,
		});
		const relativeResult = await run({
			command: `cd /tmp && mkdir -p mixed-ls-relative-dir && printf hi > mixed-ls-relative-dir/tmp.txt && ls mixed-ls-relative-dir ${test_db_files_mount}/docs`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(result.stdout).toContain("/tmp/mixed-ls-dir:\ntmp.txt");
		expect(result.stdout.trim().split("\n\n")).toEqual([
			`${test_db_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
			"/tmp/mixed-ls-dir:\ntmp.txt",
		]);
		expect(relativeResult.metadata.exitCode).toBe(0);
		expect(relativeResult.stdout.trim().split("\n\n")).toEqual([
			"mixed-ls-relative-dir:\ntmp.txt",
			`${test_db_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
		]);
	});

	test("keeps Native Just Bash ls flags when batching adjacent /tmp operands", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: `mkdir -p /tmp/mixed-ls-a /tmp/mixed-ls-b && ls -d /tmp/mixed-ls-a /tmp/mixed-ls-b ${test_db_files_mount}/docs`,
		});

		expect(result.metadata.exitCode).toBe(0);
		// Native `ls -d` prints its operands as one block, one per line, like real bash. Only the
		// app-path operand gets its own block.
		expect(result.stdout.trim().split("\n\n")).toEqual([
			"/tmp/mixed-ls-a\n/tmp/mixed-ls-b",
			`${test_db_files_mount}/docs/`,
		]);
	});

	test("rejects ls cursor continuation with multiple operands", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({
			command: `ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs ${test_db_files_mount}/reports`,
		});
		const mixedResult = await run({ command: `ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs /tmp` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("--cursor can only continue one listing target");
		expect(mixedResult.metadata.exitCode).toBe(2);
		expect(mixedResult.stderr).toContain("--cursor can only continue one listing target");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports ls -d and lets directory mode win over recursive mode", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls -dR ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/`);
		expect(result.stdout).not.toContain("readme.md");
	});

	test("supports recursive ls with full app shell paths", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls -R --limit 10 ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("supports reverse ls order through the paginated query", async () => {
		const runner = await create_bash_runner();
		const { run, runQuery } = runner;

		const result = await run({ command: `ls -r --limit 10 ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["tutorial.md", "readme.md", "nested/"]);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				folderPath: "/docs",
				order: "desc",
			}),
		);
	});

	test("ls -t lists the workspace newest-first and supports scoped immediate-child recency", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/aaa-old.md", content: "old\n", updatedAt: Date.now() - 2_000_000 },
				{ path: "/docs/zzz-new.md", content: "new\n", updatedAt: Date.now() + 10_000 },
			],
		});
		const { run, runQuery } = runner;

		const newest = await run({ command: "ls -t --limit 50" });
		const oldest = await run({ command: "ls -rt --limit 50" });
		const scopedNewest = await run({ command: `ls -t --limit 10 ${test_db_files_mount}/docs` });
		const scopedOldest = await run({ command: `ls -rt --limit 10 ${test_db_files_mount}/docs` });
		const scopedPaged = await run({ command: `ls -t --limit 1 ${test_db_files_mount}/docs` });
		const recursiveScoped = await run({ command: `ls -Rt ${test_db_files_mount}/docs` });
		const workspacePaged = await run({ command: "ls -t --limit 1" });

		expect(newest.metadata.exitCode).toBe(0);
		// Each line is "<ISO timestamp>\t<shell path>"; assert the recency formatting + a known path.
		expect(newest.stdout).toMatch(/\dT\d.*Z\t\/home\/cloud-usr\/w\/personal\/home\/docs\/readme\.md/u);
		const recencyCalls = runQuery.mock.calls
			.filter(([ref]) => function_name_of(ref) === "files_visible:internal_list_recent_saved")
			.map((call) => call[1]);
		expect(recencyCalls.some((a) => a.order === "desc")).toBe(true);
		expect(recencyCalls.some((a) => a.order === "asc")).toBe(true);
		expect(oldest.metadata.exitCode).toBe(0);
		expect(scopedNewest.metadata.exitCode).toBe(0);
		expect(scopedNewest.stdout.trim().split("\n").at(0)).toBe("zzz-new.md");
		expect(scopedOldest.metadata.exitCode).toBe(0);
		expect(scopedOldest.stdout.trim().split("\n").at(0)).toBe("aaa-old.md");
		expect(scopedPaged.stdout).toMatch(
			new RegExp(`Next page: ls -t --limit 1 --cursor \\S+ ${test_db_files_mount}/docs`, "u"),
		);
		expect(recursiveScoped.metadata.exitCode).toBe(2);
		expect(recursiveScoped.stderr).toContain("ls -t -R is not supported");
		// A draft folder move would reach a reverse subtree after its own rows, so app paths refuse it.
		const recursiveReverse = await run({ command: `ls -Rr ${test_db_files_mount}/docs` });
		expect(recursiveReverse.metadata.exitCode).toBe(2);
		expect(recursiveReverse.stderr).toContain("ls -R -r is not supported for app file paths");
		expect(workspacePaged.stdout).toContain("Next page: ls -t --limit 1 --cursor");
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list_children_saved,
			expect.objectContaining({
				folderPath: "/docs",
				orderBy: "updatedAt",
				order: "desc",
			}),
		);
	});

	test("supports app-specific long ls output", async () => {
		const { run, seeded } = await create_bash_runner();

		const result = await run({ command: `ls -la --limit 10 ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(new RegExp(`folder\\t[^\\t]+Z\\tupdatedBy=${seeded.userId}\\tnested/`, "u"));
		expect(result.stdout).toMatch(
			new RegExp(
				`file\\t[^\\t]+Z\\tupdatedBy=${seeded.userId}\\tcontentType=text/markdown;charset=utf-8\\treadme\\.md`,
				"u",
			),
		);
	});

	test("accepts ls no-op presentation flags and name sort alias", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: `ls -1apF --sort=name --indicator-style=slash --limit 10 ${test_db_files_mount}/docs`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["nested/", "readme.md", "tutorial.md"]);
	});

	test("rejects unsupported ls sorting and size flags only when db-files paths are involved", async () => {
		const { run, runQuery } = await create_bash_runner();

		const sortResult = await run({ command: `ls --sort=size ${test_db_files_mount}/docs` });
		const sizeResult = await run({ command: `ls -S ${test_db_files_mount}/docs` });
		const nativeJustBashResult = await run({ command: "ls --sort=size /tmp" });
		const mixedResult = await run({
			command: `printf hi > /tmp/unsupported-ls-tmp.txt && ls --sort=size /tmp/unsupported-ls-tmp.txt ${test_db_files_mount}/docs`,
		});

		expect(sortResult.metadata.exitCode).toBe(2);
		expect(sortResult.stderr).toContain("unsupported option --sort=size");
		expect(sortResult.stderr).toContain("/home/cloud-usr/w");
		expect(sortResult.stderr).toContain("supports name and time order only");
		expect(sizeResult.metadata.exitCode).toBe(2);
		expect(sizeResult.stderr).toContain("unsupported option -S");
		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		expect(mixedResult.metadata.exitCode).toBe(2);
		expect(mixedResult.stderr).toContain("unsupported option --sort=size");
		expect(mixedResult.stderr).toContain("/home/cloud-usr/w");
		expect(mixedResult.stdout).not.toContain("unsupported-ls-tmp.txt");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("guides invented ls pagination flags back to the printed cursor command", async () => {
		const { run } = await create_bash_runner();

		const appResult = await run({ command: `ls --limit 1 --next-page ${test_db_files_mount}/docs` });
		const nativeJustBashResult = await run({ command: "ls --next-page /tmp" });

		for (const result of [appResult, nativeJustBashResult]) {
			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
			expect(result.stderr).toContain("Next page: ls --limit N --cursor");
		}
	});

	test("supports paginated find with maxdepth and type filters", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 10` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
		expect(result.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		// -maxdepth 1 reads the folder's children.
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list_children_saved,
			expect.objectContaining({
				folderPath: "/docs",
				numItems: 10,
				position: { rangeStart: null, cursor: null, lastKey: null },
				kind: "file",
			}),
		);
	});

	test("handles exact file find targets locally with type depth and extension filters", async () => {
		const { run, runQuery } = await create_bash_runner();

		const plain = await run({ command: `find ${test_db_files_mount}/docs/readme.md --limit 10` });
		const extension = await run({ command: `find ${test_db_files_mount}/docs/readme.md --extension md --limit 10` });
		const typeFolder = await run({ command: `find ${test_db_files_mount}/docs/readme.md -type d --limit 10` });
		const tooDeep = await run({ command: `find ${test_db_files_mount}/docs/readme.md -mindepth 1 --limit 10` });

		expect(plain.metadata.exitCode).toBe(0);
		expect(plain.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(extension.metadata.exitCode).toBe(0);
		expect(extension.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(typeFolder.stdout.trim()).toBe("0 matches.");
		expect(tooDeep.stdout.trim()).toBe("0 matches.");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
	});

	test("supports app-file find name word search", async () => {
		// convex-test's search index splits document words on whitespace only, so the word
		// query can only land on a path segment that follows a space in the file name.
		const wordSearchPath = "/docs/word readme.md";
		const outsideWordSearchPath = "/word readme-outside.md";
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: wordSearchPath, content: "word search fixture\n" },
				{ path: outsideWordSearchPath, content: "outside word search fixture\n" },
				{ path: "/docs/scope word/child.md", content: "child under scope word\n" },
			],
		});
		const { run, runQuery } = runner;

		const nameResult = await run({ command: "find -name readme --limit 10" });
		const explicitResult = await run({ command: "find --path-query readme --limit 10" });
		const scopedResult = await run({
			command: `find ${test_db_files_mount}/docs -maxdepth 1 -name readme -type f --limit 10`,
		});
		const subtreeResult = await run({ command: `find ${test_db_files_mount}/docs -name readme --limit 10` });
		const dottedNameResult = await run({
			command: `find ${test_db_files_mount}/docs -type f -name 'word readme.md' --limit 10`,
		});
		const scopedSelfResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -name child --limit 10`,
		});
		const scopedMindepthResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -mindepth 1 -name child --limit 10`,
		});
		const scopedRootResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -name scope --limit 10`,
		});
		const scopedRootMindepthResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -mindepth 1 -name scope --limit 10`,
		});

		expect(nameResult.metadata.exitCode).toBe(0);
		expect(nameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(nameResult.stdout).toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
		// App files search names only, and the name index has no parent filter.
		expect(explicitResult.metadata.exitCode).toBe(2);
		expect(explicitResult.stderr).toBe(
			"find: --path-query is not supported for app files; use find <folder> -name QUERY\n",
		);
		expect(scopedResult.metadata.exitCode).toBe(2);
		expect(scopedResult.stderr).toBe(
			"find: -maxdepth 1 -name is not supported for app files; use find <folder> -name QUERY for the whole folder, or ls <folder>\n",
		);
		// A folder scope searches the full subtree and leaves out the rest.
		expect(subtreeResult.metadata.exitCode).toBe(0);
		expect(subtreeResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(subtreeResult.stdout).not.toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
		expect(dottedNameResult.metadata.exitCode).toBe(0);
		expect(dottedNameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(dottedNameResult.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		for (const result of [scopedSelfResult, scopedMindepthResult]) {
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}/docs/scope word/child.md\n`);
		}
		// Like GNU find, the start folder prints when its own name matches, unless -mindepth 1.
		expect(scopedRootResult.stdout).toBe(`${test_db_files_mount}/docs/scope word/\n`);
		expect(scopedRootMindepthResult.stdout).toBe("0 matches.\n");
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_search_name_saved,
			expect.objectContaining({ query: "readme", folderPath: "/" }),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_search_name_places,
			expect.objectContaining({ query: "readme", folderPath: "/docs" }),
		);
	});

	test("supports find -mindepth and accepts -print as a no-op", async () => {
		const { run } = await create_bash_runner();

		const self = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 0 --limit 50` });
		const below = await run({ command: `find ${test_db_files_mount}/docs -mindepth 1 --limit 50` });
		const deepOnly = await run({ command: `find ${test_db_files_mount}/docs -mindepth 2 --limit 50` });
		const twoLevels = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 2 --limit 50` });
		const directOnly = await run({ command: `find ${test_db_files_mount}/docs -mindepth 1 -maxdepth 1 --limit 50` });
		const printed = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 1 -print --limit 50` });

		// App folders take three depth shapes: the folder, its children, or its whole subtree.
		expect(self.stdout.trim()).toBe(`${test_db_files_mount}/docs/`);
		expect(below.metadata.exitCode).toBe(0);
		expect(below.stdout).not.toContain(`${test_db_files_mount}/docs/\n`);
		expect(below.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		for (const refused of [deepOnly, twoLevels]) {
			expect(refused.metadata.exitCode).toBe(2);
			expect(refused.stderr).toContain(
				"support only the folder itself (-maxdepth 0), its direct children (-maxdepth 1), or the whole subtree",
			);
		}
		expect(directOnly.metadata.exitCode).toBe(0);
		expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
		expect(directOnly.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(printed.metadata.exitCode).toBe(0);
		expect(printed.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("rejects a non-integer find -mindepth and round-trips it in the continuation", async () => {
		const { run } = await create_bash_runner();

		const invalid = await run({ command: `find ${test_db_files_mount}/docs -mindepth x --limit 10` });
		const paged = await run({ command: `find ${test_db_files_mount}/docs -mindepth 1 --limit 1` });

		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("-mindepth must be a non-negative integer");
		expect(paged.metadata.exitCode).toBe(0);
		expect(paged.stdout).toContain("Next page: find");
		expect(paged.stdout).toContain("-mindepth 1");
	});

	test("rejects find --prefix combined with depth flags", async () => {
		const { run, runQuery } = await create_bash_runner();

		const maxResult = await run({ command: `find --prefix ${test_db_files_mount}/docs -maxdepth 1 --limit 10` });
		const minResult = await run({ command: `find --prefix ${test_db_files_mount}/docs -mindepth 2 --limit 10` });

		expect(maxResult.metadata.exitCode).toBe(2);
		expect(maxResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
		expect(minResult.metadata.exitCode).toBe(2);
		expect(minResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports indexed app-file find extension search and simple extension glob recovery", async () => {
		const { run, runQuery } = await create_bash_runner();

		const globName = await run({ command: "find -name '*.md' --limit 10" });
		const extension = await run({ command: `find ${test_db_files_mount}/docs --extension md --limit 10` });
		const pathGlob = await run({ command: `find ${test_db_files_mount}/docs/*.md --limit 1` });

		expect(globName.metadata.exitCode).toBe(0);
		expect(globName.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(extension.metadata.exitCode).toBe(0);
		expect(extension.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(pathGlob.metadata.exitCode).toBe(0);
		expect(pathGlob.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(pathGlob.stdout).toMatch(
			new RegExp(`Next page: find ${test_db_files_mount}/docs --extension md --limit 1 --cursor \\S+`, "u"),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_nodes.list_subtree,
			expect.objectContaining({
				folderPath: "/docs",
				kind: "file",
				lowercaseExtension: "md",
			}),
		);
	});

	test("rejects find combinations that still cannot stay indexed", async () => {
		const { run } = await create_bash_runner();

		const scopedDepth = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 2 -name readme --limit 10` });
		const tokenGlobName = await run({ command: "find -type f -name '*readme*' --limit 10" });
		const prefixExtensionGlobName = await run({
			command: `find ${test_db_files_mount}/docs -type f -name 'readme*.md' --limit 10`,
		});
		const complexGlobName = await run({ command: "find -name 'read.*.md' --limit 10" });
		const pathQueryGlob = await run({ command: "find --path-query '.*readme.*' --limit 10" });
		const combinedPathQueryExtension = await run({
			command: `find ${test_db_files_mount}/docs -type f --extension md --path-query readme --limit 10`,
		});
		const recursivePathQuery = await run({
			command: `find ${test_db_files_mount} -maxdepth 5 -type f --path-query readme --limit 10`,
		});
		const regexPathPredicate = await run({
			command: `find ${test_db_files_mount}/docs -type f -regex '.*readme.*' --limit 10`,
		});

		expect(scopedDepth.metadata.exitCode).toBe(2);
		expect(scopedDepth.stderr).toContain("name search reads the whole folder; omit -maxdepth.");
		expect(scopedDepth.stderr).toContain(`Try: find ${test_db_files_mount}/docs -name readme --limit 10`);
		expect(tokenGlobName.metadata.exitCode).toBe(2);
		expect(tokenGlobName.stderr).toContain(`Try: find ${test_db_files_mount} -type f -name readme --limit 10`);
		expect(prefixExtensionGlobName.metadata.exitCode).toBe(2);
		expect(prefixExtensionGlobName.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f -name readme --limit 10`,
		);
		expect(complexGlobName.metadata.exitCode).toBe(2);
		expect(complexGlobName.stderr).toContain("not glob patterns");
		expect(complexGlobName.stderr).toContain("Try `find <dir> -type f --extension md");
		expect(pathQueryGlob.metadata.exitCode).toBe(2);
		expect(pathQueryGlob.stderr).toContain("--path-query uses path word search for /.plugins and /.mounts");
		expect(pathQueryGlob.stderr).toContain(`Try: find ${test_db_files_mount} -name readme --limit 10`);
		expect(combinedPathQueryExtension.metadata.exitCode).toBe(2);
		expect(combinedPathQueryExtension.stderr).toContain("--path-query is not supported for app files");
		expect(recursivePathQuery.metadata.exitCode).toBe(2);
		expect(recursivePathQuery.stderr).toContain("--path-query is not supported for app files");
		expect(regexPathPredicate.metadata.exitCode).toBe(2);
		expect(regexPathPredicate.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f -name readme --limit 10`,
		);
	});

	test("filters non-search find pages before pagination", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 1` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
		expect(result.stdout).toContain("Next page:");
	});

	test("rejects unsupported find predicates when pagination is requested", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `find ${test_db_files_mount}/docs -delete --limit 10` });
		const regexResult = await run({
			command: `find ${test_db_files_mount}/docs -regextype posix-extended -regex '.*readme.*' --limit 10`,
		});
		const nativeJustBashResult = await run({ command: "find /tmp -mtime 1 --limit 1" });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("unsupported predicate -delete");
		expect(result.stderr).toContain("/home/cloud-usr/w");
		expect(result.stderr).toContain("use -name QUERY");
		expect(result.stderr).toContain("Usage: find");
		expect(regexResult.metadata.exitCode).toBe(2);
		expect(regexResult.stderr).toContain("unsupported predicate -regextype");
		expect(regexResult.stderr).toContain("use -name with plain name words");
		expect(regexResult.stderr).toContain(`Try: find ${test_db_files_mount}/docs -name readme --limit 10`);
		expect(regexResult.stderr).not.toContain("supports one path only");
		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("ignores app pagination options outside the app file mount without Convex queries", async () => {
		const { run, runQuery } = await create_bash_runner();

		const lsResult = await run({ command: "ls --limit 1 /tmp" });
		const lsCursorResult = await run({ command: "ls /tmp --cursor missing" });
		const findResult = await run({ command: "find /tmp --limit 1" });
		const findCursorResult = await run({ command: "find /tmp --cursor missing" });
		const plainTreeResult = await run({ command: "tree /tmp" });
		const treeResult = await run({ command: "tree /tmp --limit 1" });
		const treeCursorResult = await run({ command: "tree /tmp --cursor missing" });
		const malformedLimitResult = await run({ command: "ls --limit nope /tmp" });

		expect(lsResult.metadata.exitCode).toBe(0);
		expect(lsCursorResult.metadata.exitCode).toBe(0);
		expect(findResult.metadata.exitCode).toBe(0);
		expect(findCursorResult.metadata.exitCode).toBe(0);
		expect(treeResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
		expect(treeResult.stdout).toBe(plainTreeResult.stdout);
		expect(treeResult.stderr).toBe(plainTreeResult.stderr);
		expect(treeCursorResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
		expect(treeCursorResult.stdout).toBe(plainTreeResult.stdout);
		expect(treeCursorResult.stderr).toBe(plainTreeResult.stderr);
		expect(malformedLimitResult.metadata.exitCode).toBe(2);
		expect(malformedLimitResult.stderr).toContain("ls: --limit must be an integer");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("resolves exact parent folders through db-files path lookups", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `cd ${test_db_files_mount}/reports && pwd` });
		const reportsLookupCalls = runQuery.mock.calls.filter((call) => {
			const queryArgs = call[1];
			return (
				queryArgs &&
				typeof queryArgs === "object" &&
				!("maxDepth" in queryArgs) &&
				"path" in queryArgs &&
				queryArgs.path === "/reports"
			);
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/reports`);
		expect(reportsLookupCalls.length).toBeGreaterThan(0);
	});

	test("rejects app glob patterns without falling back to capped enumeration", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls ${test_db_files_mount}/docs/*.md` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.metadata.pathIndexTruncated).toBe(false);
		expect(result.stderr).toContain("app file glob patterns are not supported");
		expect(result.stderr).toContain(`Try: find ${test_db_files_mount}/docs -type f --extension md --limit 20`);
	});

	test("expands scratch globs but rejects app globs after cwd resolution", async () => {
		const { run } = await create_bash_runner();

		const writeTmp = await run({ command: "printf 'alpha\\n' > /tmp/a.txt && printf 'beta\\n' > /tmp/b.txt" });
		const cdTmp = await run({ command: "cd /tmp" });
		const tmpGlob = await run({ command: "cat *.txt" });
		const cdApp = await run({ command: `cd ${test_db_files_mount}/docs` });
		const appGlob = await run({ command: "ls *.md" });

		expect(writeTmp.metadata.exitCode).toBe(0);
		expect(cdTmp.metadata.exitCode).toBe(0);
		expect(tmpGlob.metadata.exitCode).toBe(0);
		expect(tmpGlob.stdout).toContain("alpha\n");
		expect(tmpGlob.stdout).toContain("beta\n");
		expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
		expect(cdApp.metadata.exitCode).toBe(0);
		expect(appGlob.metadata.exitCode).toBe(2);
		expect(appGlob.stderr).toContain("app file glob patterns are not supported");
		expect(appGlob.stderr).toContain("Try: find . -type f --extension md --limit 20");
	});

	test("does not alias root listing to app files", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "ls /" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).not.toContain("docs");
		expect(result.stdout).not.toContain("source.pdf");
		expect(result.stdout).toContain("home");
		expect(result.stdout).toContain("tmp");
	});

	test("does not expose the removed legacy mount", async () => {
		const { run } = await create_bash_runner();
		const legacyMount = "/work" + "space";

		const result = await run({ command: `ls ${legacyMount}` });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("readme.md");
	});

	test("explains unreadable uploaded source files through bash cat", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/source.pdf` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content type is 'application/pdf'");
		expect(result.stderr).toContain("Bash can read editable text files only");
		expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(result.stderr).toContain(`${test_db_files_mount}/source.md`);
		expect(result.stderr).toContain(`${test_db_files_mount}/source.txt`);
	});

	test("keeps unreadable cat advisories out of pipelines", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/source.pdf | grep application/pdf` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content type is 'application/pdf'");
	});

	test("does not suggest rereading the same unreadable file path", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/uploaded.md` });
		const suggestionLine = result.stderr
			.split("\n")
			.find((line) => line.startsWith("To read generated text output for this file"));

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(suggestionLine).toBeDefined();
		// The advisory must suggest readable siblings, never re-reading the same unreadable path.
		expect(suggestionLine).not.toContain(`${test_db_files_mount}/uploaded.md,`);
		expect(suggestionLine?.endsWith(`${test_db_files_mount}/uploaded.md`)).toBe(false);
		expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.md.md`);
		expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.txt`);
	});

	test("app redirect writes become pending proposals and same-thread /tmp scratch files persist", async () => {
		const { run, runMutation } = await create_bash_runner();

		const organizationWrite = await run({ command: `echo nope > ${test_db_files_mount}/docs/new.md` });
		expect(organizationWrite.metadata.exitCode).toBe(0);
		expect(organizationWrite.stderr).toBe("");

		const tmpWrite = await run({ command: "printf hi > /tmp/a.txt" });
		expect(tmpWrite.metadata.exitCode).toBe(0);

		const nextInvocation = await run({ command: "cat /tmp/a.txt" });
		expect(nextInvocation.metadata.exitCode).toBe(0);
		expect(nextInvocation.stdout).toBe("hi");

		// Only the tmp write flushes; the app proposal write and the read do not.
		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		expect(patchCalls).toHaveLength(1);
	});

	test("flushes only changed /tmp paths as a delta", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run({ command: "printf one > /tmp/a.txt && printf two > /tmp/b.txt" });
		const update = await run({ command: "printf ONE > /tmp/a.txt" });

		expect(update.metadata.exitCode).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
					deletePaths: string[];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a.txt"]);
		expect(lastPatchArgs?.fileNodesContent).toEqual([{ path: "/a.txt", content: expect.any(ArrayBuffer) }]);
		expect(lastPatchArgs?.deletePaths).toEqual([]);

		const read = await run({ command: "cat /tmp/a.txt /tmp/b.txt" });
		expect(read.stdout).toBe("ONEtwo");
	});

	test("flushes a /tmp file whose name is not ASCII and one that holds half a character", async () => {
		const { run, runMutation } = await create_bash_runner();

		// Convex allows only printable ASCII field names, so while this payload kept the content in a
		// record keyed by path, one file named `café.txt` failed the whole call. A name can also hold
		// half a character, which Convex refuses anywhere. That one is repaired on its way out, like the
		// output is.
		const wrote = await run({ command: `printf hi > /tmp/café.txt && printf hi > "/tmp/$(printf 'a\\ud83c').txt"` });
		expect(wrote.metadata.exitCode, wrote.stderr).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path).sort()).toEqual(["/a�.txt", "/café.txt"]);
		expect(lastPatchArgs?.fileNodesContent.map((entry) => entry.path).sort()).toEqual(["/a�.txt", "/café.txt"]);
	});

	test("keeps one /tmp node when two names repair to the same path", async () => {
		const { run, runMutation } = await create_bash_runner();

		// Every half of a character is repaired to the same U+FFFD, so these two names leave the call as
		// one path. Only one node may be sent for it. Two would write two docs for one path, and the next
		// call could not even build the filesystem: `mkdir` refuses a path a file already holds, so every
		// later call in the thread would fail before it ran a command.
		const wrote = await run({
			command: `printf hi > "/tmp/$(printf 'a\\ud83c').txt" && mkdir "/tmp/$(printf 'a\\udf89').txt"`,
		});
		expect(wrote.metadata.exitCode, wrote.stderr).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| { fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"] }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a�.txt"]);

		// The thread still works: the next call reads the /tmp it just wrote.
		expect((await run({ command: "ls /tmp" })).metadata.exitCode).toBe(0);
	});
	test("flushes /tmp removals as delete-only deltas", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run({ command: "printf one > /tmp/a.txt && printf two > /tmp/b.txt" });
		const remove = await run({ command: "rm /tmp/a.txt" });

		expect(remove.metadata.exitCode).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as { fileNodes: unknown[]; deletePaths: string[] } | undefined;
		expect(lastPatchArgs?.fileNodes).toEqual([]);
		expect(lastPatchArgs?.deletePaths).toEqual(["/a.txt"]);
	});

	test("persists nested /tmp creates and recursive deletes through deltas", async () => {
		const { run } = await create_bash_runner();

		const create = await run({ command: "mkdir -p /tmp/a/b && printf nested > /tmp/a/b/c.txt" });
		expect(create.metadata.exitCode).toBe(0);

		const hydratedRead = await run({ command: "cat /tmp/a/b/c.txt" });
		expect(hydratedRead.metadata.exitCode).toBe(0);
		expect(hydratedRead.stdout).toBe("nested");

		const remove = await run({ command: "rm -r /tmp/a" });
		expect(remove.metadata.exitCode).toBe(0);

		const missing = await run({ command: "cat /tmp/a/b/c.txt" });
		expect(missing.metadata.exitCode).not.toBe(0);
		expect(missing.stderr).toContain("No such file");
	});

	test("persists /tmp copy and move changes through deltas", async () => {
		const { run } = await create_bash_runner();

		await run({
			command: "mkdir -p /tmp/src && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt",
		});
		const copyMove = await run({ command: "cp -r /tmp/src /tmp/copy && mv /tmp/to-move.txt /tmp/moved.txt" });

		expect(copyMove.metadata.exitCode).toBe(0);

		const read = await run({ command: "cat /tmp/src/a.txt /tmp/copy/a.txt /tmp/moved.txt" });
		expect(read.stdout).toBe("copiedcopiedmoved");
	});

	test("persists /tmp copy and move into existing directories through real destination paths", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run({
			command:
				"mkdir -p /tmp/src /tmp/copy-dir /tmp/move-dir && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt",
		});
		runMutation.mockClear();

		const copyMove = await run({ command: "cp /tmp/src/a.txt /tmp/copy-dir && mv /tmp/to-move.txt /tmp/move-dir" });

		expect(copyMove.metadata.exitCode).toBe(0);
		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
					deletePaths: string[];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual([
			"/copy-dir/a.txt",
			"/move-dir/to-move.txt",
		]);
		expect(lastPatchArgs?.fileNodesContent).toEqual([
			{ path: "/copy-dir/a.txt", content: expect.any(ArrayBuffer) },
			{ path: "/move-dir/to-move.txt", content: expect.any(ArrayBuffer) },
		]);
		expect(lastPatchArgs?.deletePaths).toEqual(["/to-move.txt"]);

		const read = await run({ command: "cat /tmp/copy-dir/a.txt /tmp/move-dir/to-move.txt" });
		expect(read.stdout).toBe("copiedmoved");
	});

	test("scopes durable /tmp scratch files by thread", async () => {
		const writer = await create_bash_runner();
		await writer.run({ command: "printf thread-a > /tmp/scope.txt" });
		const shared = { t: writer.t, seeded: writer.seeded };

		const sameScope = await create_bash_runner({ shared, threadId: writer.threadId });
		const sameScopeRead = await sameScope.run({ command: "cat /tmp/scope.txt" });
		expect(sameScopeRead.metadata.exitCode).toBe(0);
		expect(sameScopeRead.stdout).toBe("thread-a");

		const otherThread = await create_bash_runner({ shared });
		const otherThreadRead = await otherThread.run({ command: "cat /tmp/scope.txt" });
		expect(otherThreadRead.metadata.exitCode).not.toBe(0);
		expect(otherThreadRead.stderr).toContain("No such file");

		const otherUserSeeded = await writer.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, {}));
		const sameThreadOtherUser = await create_bash_runner({
			shared,
			threadId: writer.threadId,
			userId: otherUserSeeded.userId,
		});
		await expect(sameThreadOtherUser.run({ command: "cat /tmp/scope.txt" })).rejects.toThrow("Unauthorized");
	});

	test("merges parallel same-thread /tmp writes through deltas", async () => {
		const { run } = await create_bash_runner();

		const [aResult, bResult] = await Promise.all([
			run({ command: "printf a > /tmp/a.txt" }),
			run({ command: "printf b > /tmp/b.txt" }),
		]);
		expect(aResult.metadata.exitCode).toBe(0);
		expect(bResult.metadata.exitCode).toBe(0);

		const read = await run({ command: "cat /tmp/a.txt /tmp/b.txt" });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toBe("ab");
	});

	test("evicts the oldest /tmp scratch paths beyond the path cap", async () => {
		const { run } = await create_bash_runner();

		await run({ command: "printf old > /tmp/old.txt" });
		// The path cap is private to bash.ts and small in dev. 20 new paths are enough to go over it.
		// The exact eviction count is asserted by the in-source tmp_fs_evict_to_limits tests.
		const paths = Array.from({ length: 20 }, (_, index) => `/tmp/p-${index}.txt`).join(" ");
		const overflow = await run({ command: `touch ${paths}` });
		expect(overflow.metadata.exitCode).toBe(0);
		// old.txt was written by an earlier call, so it is the oldest path and is listed first.
		expect(overflow.stderr).toContain("oldest path(s) to fit: /tmp/old.txt");

		const list = await run({ command: "ls /tmp" });
		expect(list.stdout).toContain("p-");
		expect(list.stdout).not.toContain("old.txt");
	});

	test("evicts the oldest /tmp scratch files beyond the byte cap", async () => {
		const { run } = await create_bash_runner();

		// Each seq output is ~1.7KB: under the per-file cap, but three together pass the 4KB session cap.
		const first = await run({ command: "seq 1 470 > /tmp/a.txt" });
		expect(first.stderr).toBe("");
		const overflow = await run({ command: "seq 1 470 > /tmp/b.txt && seq 1 470 > /tmp/c.txt" });
		expect(overflow.metadata.exitCode).toBe(0);
		expect(overflow.stderr).toContain("evicted the 1 oldest path(s) to fit: /tmp/a.txt");

		const evictedRead = await run({ command: "cat /tmp/a.txt" });
		expect(evictedRead.metadata.exitCode).not.toBe(0);
		const survivorsRead = await run({ command: "cat /tmp/b.txt /tmp/c.txt" });
		expect(survivorsRead.metadata.exitCode).toBe(0);
	});

	test("evicts only the offending /tmp file beyond the per-file cap", async () => {
		const { run } = await create_bash_runner();

		// seq 1 1000 is ~3.9KB, past the 2KB per-file cap.
		const result = await run({ command: "seq 1 1000 > /tmp/big.txt && printf keep > /tmp/keep.txt" });
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toContain("discarded 1 oversized file(s): /tmp/big.txt");

		const read = await run({ command: "cat /tmp/keep.txt && cat /tmp/big.txt" });
		expect(read.stdout).toBe("keep");
		expect(read.metadata.exitCode).not.toBe(0);
	});

	test("creates persistent app file tree folders through bash mkdir when allowed", async () => {
		const { run, runMutation, seeded } = await create_bash_runner({ allowDbFilesMkdir: true });

		const result = await run({
			command: `mkdir ${test_db_files_mount}/bash-created && stat ${test_db_files_mount}/bash-created && ls ${test_db_files_mount}`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("drwx");
		expect(result.stdout).toContain("bash-created");
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: "/bash-created",
				userId: seeded.userId,
			}),
		);
	});

	test("blocks app file tree folder creation through bash mkdir when not allowed", async () => {
		const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: false });

		const result = await run({ command: `mkdir ${test_db_files_mount}/ask-denied` });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Agent mode");
		expect(result.stderr).toContain("Scratch space does not create durable folders");
		expect(runMutation).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: "/ask-denied",
			}),
		);
	});

	test("normalizes the skills folder through bash mkdir", async () => {
		const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: true });
		const result = await run({ command: `mkdir -p ${test_db_files_mount}/.AGENTS/skills/one` });
		expect(result.metadata.exitCode).toBe(0);
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ path: "/.agents/skills/one" }),
		);
	});

	test("runs indexed search with options before the query", async () => {
		const { run, runQuery, seeded } = await create_bash_runner();

		const result = await run({ command: "search --limit 5 unique-token" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("unique-token");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: seeded.userId,
				query: "unique-token",
				numItems: 5,
				cursor: null,
			}),
		);
	});

	test("runs indexed search with equals-form options", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `search --path=${test_db_files_mount}/docs --limit=5 unique-token` });

		expect(result.metadata.exitCode).toBe(0);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				query: "unique-token",
				numItems: 5,
				pathPrefix: "/docs",
			}),
		);
	});

	test("annotates broad full-text results for exact hyphenated token searches", async () => {
		// The broad fixture's intraword bold breaks the literal token in the markdown chunk while
		// the plain-text search index still matches it; the hit stays in the page with a
		// word-level note instead of being filtered out.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
			],
		});

		const result = await run({ command: "search --limit 5 exact-hyphen-token-2026" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Found 2 results (exact matches: 1, word-level-only matches: 1; see per-hit notes)",
		);
		expect(result.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		expect(result.stdout).toMatch(
			/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("finds content whose phrase spans a chunk boundary", async () => {
		// Chunks are cut at a hard character offset with no overlap (see OVERLAP in
		// files-markdown-chunking-mastra.ts), so a phrase across the cut lives in no single chunk.
		// Recall must not depend on overlap: the per-chunk term index still has to surface the file.
		const phrase = "quarterly revenue reconciliation";
		const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/split/boundary.md",
					content: `# Report\n\n${filler.repeat(20).slice(0, 1190)}${phrase} tail words follow.\n`,
				},
			],
		});

		const result = await run({ command: `search --limit 5 "${phrase}"` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Found 1 results");
		expect(result.stdout).toContain("/split/boundary.md");
		// The snippet shows the side of the cut that holds most of the phrase, and flags the rest.
		expect(result.stdout).toContain("revenue reconciliation tail words follow.");
		expect(result.stdout).toContain("... more content above");
	});

	test("keeps word-level-only search pages full and the continuation reachable", async () => {
		// Broad file is seeded first so the limit-1 first page holds only the word-level hit;
		// the exact match lives on the next page and must stay reachable via Next page.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
				{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
			],
		});

		const firstPage = await run({ command: "search --limit 1 exact-hyphen-token-2026" });

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain(
			"Found 1 results (exact matches: 0, word-level-only matches: 1; see per-hit notes)",
		);
		expect(firstPage.stdout).toMatch(
			/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
		expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ exact-hyphen-token-2026/u);
		expect(firstPage.stdout.indexOf("Next page: search")).toBeLessThan(
			firstPage.stdout.indexOf(`${test_db_files_mount}/search-fixtures/broad.md`),
		);
		expect(firstPage.stdout).toContain("run the exact Next page command before answering");

		const continuation = firstPage.stdout.match(/Next page: (search .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a search continuation in the first page stdout");
		}
		const secondPage = await run({ command: continuation });

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("exact-hyphen-token-2026 inside");
		expect(secondPage.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
	});

	test("rejects indexed search invalid limit values", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: "search --limit nope unique-token" });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("search: --limit must be an integer");
		expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
	});

	test("prints a search continuation when indexed search has another db page", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
				{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
			],
		});

		const firstPage = await run({ command: "search --limit 1 paged-token" });
		const complete = await run({ command: "search --limit 5 unique-token" });

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain("Found 1 results");
		expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ paged-token/u);
		expect(complete.stdout).not.toContain("Next page: search");
		const pageProbeCalls = runQuery.mock.calls.filter(
			([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
		);
		expect(pageProbeCalls).toHaveLength(0);
	});

	test("reports unknown indexed search cursor ids", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: "search --limit 1 --cursor cursor-1 paged-token" });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: "cursor-1" });
	});

	test("does not probe scoped search continuations because Convex filters paginate results", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
				{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
			],
		});

		const result = await run({ command: `search --path ${test_db_files_mount}/docs --limit 1 paged-token` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Next page: search --path");
		expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "paged-token", pathPrefix: "/docs", numItems: 1 }),
		);
		const pageProbeCalls = runQuery.mock.calls.filter(
			([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
		);
		expect(pageProbeCalls).toHaveLength(0);
	});

	test("rejects db-files path operands in indexed search instead of folding them into the query", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `search --limit 5 unique-token ${test_db_files_mount}` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("path operands are not supported");
		expect(result.stderr).toContain("search --path <folder>");
		expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
	});

	test("scopes indexed search to a folder with --path", async () => {
		const { run, runQuery } = await create_bash_runner();

		// In-scope folder -> hit, and the db-files path is passed through to the query.
		const inScope = await run({ command: `search --path ${test_db_files_mount}/docs unique-token` });
		expect(inScope.metadata.exitCode).toBe(0);
		expect(inScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(inScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);

		// Bare search follows the current app cwd so "cd dir && search term" stays db-scoped.
		const cwdScope = await run({ command: `cd ${test_db_files_mount}/docs && search unique-token` });
		expect(cwdScope.metadata.exitCode).toBe(0);
		expect(cwdScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(cwdScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
		const searchCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
		expect(searchCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

		// Relative --path (including `.`) resolves against the current working directory.
		const relScope = await run({ command: `cd ${test_db_files_mount} && search --path docs unique-token` });
		expect(relScope.metadata.exitCode).toBe(0);
		expect(relScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(relScope.stdout).toContain(`under ${test_db_files_mount}/docs`);

		const dotScope = await run({ command: `cd ${test_db_files_mount}/docs && search --path . unique-token` });
		expect(dotScope.metadata.exitCode).toBe(0);
		expect(dotScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		const relCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
		expect(relCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

		// Explicit --path scopes must be real app folders.
		const missingScope = await run({ command: `search --path ${test_db_files_mount}/other unique-token` });
		expect(missingScope.metadata.exitCode).toBe(1);
		expect(missingScope.stderr).toContain("--path folder does not exist");

		const fileScope = await run({ command: `search --path ${test_db_files_mount}/docs/readme.md unique-token` });
		expect(fileScope.metadata.exitCode).toBe(2);
		expect(fileScope.stderr).toContain("--path must be a folder");

		// A --path outside currentWorkspacePath (and outside any mount) is rejected.
		const bad = await run({ command: "search --path /etc unique-token" });
		expect(bad.metadata.exitCode).toBe(2);
		expect(bad.stderr).toContain("--path must be a folder under");
	});

	test("textgrep scans one file's rendered plain text and maps -R to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
		});
		const filePath = `${test_db_files_mount}/docs/textgrep.md`;

		// Single-file regex over rendered plain text: no line numbers, no separators.
		const singleFile = await run({ command: `textgrep 'critical\\s+alert' ${filePath}` });
		expect(singleFile.metadata.exitCode).toBe(0);
		expect(singleFile.stdout).toBe("critical alert\n");
		expect(singleFile.stderr).toBe("");

		// -F treats regex metacharacters literally, so "critical.alert" does not match.
		const fixed = await run({ command: `textgrep -F 'critical.alert' ${filePath}` });
		expect(fixed.metadata.exitCode).toBe(1);
		expect(fixed.stdout).toBe("");

		// -c counts matching lines; an absent pattern still prints 0 (exit 1).
		const count = await run({ command: `textgrep -c 'critical' ${filePath}` });
		expect(count.metadata.exitCode).toBe(0);
		expect(count.stdout).toBe("1\n");
		const countAbsent = await run({ command: `textgrep -c 'absent-token' ${filePath}` });
		expect(countAbsent.metadata.exitCode).toBe(1);
		expect(countAbsent.stdout).toBe("0\n");

		// -l prints the path when there is a match.
		const list = await run({ command: `textgrep -l 'critical' ${filePath}` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout).toBe(`${filePath}\n`);

		// -v keeps non-matching lines.
		const invert = await run({ command: `textgrep -v 'critical' ${filePath}` });
		expect(invert.metadata.exitCode).toBe(0);
		expect(invert.stdout).not.toContain("critical alert");

		// -R folder scan routes to indexed full-text search, mirroring grep -R.
		const recursive = await run({ command: `textgrep -R unique-token ${test_db_files_mount}/docs` });
		expect(recursive.metadata.exitCode).toBe(0);
		expect(recursive.stdout).toContain("uses indexed full-text search");
		expect(recursive.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
		expect(recursive.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(true);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);

		// Invalid regex over a single file is reported.
		const invalid = await run({ command: `textgrep '[' ${filePath}` });
		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("invalid regex");

		// -n is rejected with a pointer to grep.
		const lineNumbers = await run({ command: `textgrep -n 'critical' ${filePath}` });
		expect(lineNumbers.metadata.exitCode).toBe(2);
		expect(lineNumbers.stderr).toContain("grep -n");
	});

	test("textgrep parses extended grep flags and rejects unsupported / recursive-fixed-string forms", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
		});
		const filePath = `${test_db_files_mount}/docs/textgrep.md`;
		const folder = `${test_db_files_mount}/docs`;

		// -e / --regexp supply the pattern explicitly.
		const dashE = await run({ command: `textgrep -e 'critical' ${filePath}` });
		expect(dashE.metadata.exitCode).toBe(0);
		expect(dashE.stdout).toBe("critical alert\n");
		const longRegexp = await run({ command: `textgrep --regexp='critical' ${filePath}` });
		expect(longRegexp.metadata.exitCode).toBe(0);
		expect(longRegexp.stdout).toBe("critical alert\n");

		// Combined short flags: -iF (ignore-case + fixed string), -cl (count + list → list wins).
		const combinedIF = await run({ command: `textgrep -iF 'CRITICAL' ${filePath}` });
		expect(combinedIF.metadata.exitCode).toBe(0);
		expect(combinedIF.stdout).toBe("critical alert\n");
		const combinedCL = await run({ command: `textgrep -cl 'critical' ${filePath}` });
		expect(combinedCL.metadata.exitCode).toBe(0);
		expect(combinedCL.stdout).toBe(`${filePath}\n`);

		// Long aliases mirror their short forms.
		const longFixed = await run({ command: `textgrep --fixed-strings 'critical.alert' ${filePath}` });
		expect(longFixed.metadata.exitCode).toBe(1);
		expect(longFixed.stdout).toBe("");
		const longInvert = await run({ command: `textgrep --invert-match 'critical' ${filePath}` });
		expect(longInvert.metadata.exitCode).toBe(0);
		expect(longInvert.stdout).not.toContain("critical alert");
		const longCount = await run({ command: `textgrep --count 'critical' ${filePath}` });
		expect(longCount.metadata.exitCode).toBe(0);
		expect(longCount.stdout).toBe("1\n");
		const longList = await run({ command: `textgrep --files-with-matches 'critical' ${filePath}` });
		expect(longList.metadata.exitCode).toBe(0);
		expect(longList.stdout).toBe(`${filePath}\n`);

		// Context flags are rejected with a pointer to grep.
		for (const contextFlag of ["-A 1", "-B 1", "-C 1", "--context=2"]) {
			const contextRes = await run({ command: `textgrep ${contextFlag} 'critical' ${filePath}` });
			expect(contextRes.metadata.exitCode).toBe(2);
			expect(contextRes.stderr).toContain("context windows");
		}

		// Markdown scan-window flags are rejected.
		const startLine = await run({ command: `textgrep --start-line 2 'critical' ${filePath}` });
		expect(startLine.metadata.exitCode).toBe(2);
		expect(startLine.stderr).toContain("scan-window");
		const startIndex = await run({ command: `textgrep --start-index 0 'critical' ${filePath}` });
		expect(startIndex.metadata.exitCode).toBe(2);
		expect(startIndex.stderr).toContain("scan-window");

		// Removed folder-regex flags now surface as unsupported options.
		for (const removedFlag of ["--path", "--limit", "--cursor"]) {
			const removed = await run({ command: `textgrep ${removedFlag} 'critical' ${filePath}` });
			expect(removed.metadata.exitCode).toBe(2);
			expect(removed.stderr).toContain(`unsupported option ${removedFlag}`);
		}

		// Recursive -c / -l / -v fall to single-file guidance, never indexed search.
		for (const recursiveFlag of ["-c", "-l", "-v"]) {
			const recursive = await run({ command: `textgrep -R ${recursiveFlag} 'critical' ${folder}` });
			expect(recursive.metadata.exitCode).toBe(2);
			expect(recursive.stdout).toContain("textgrep regex runs over ONE app file");
		}

		// Recursive -F is rejected: indexed scans cannot do exact fixed-string matching.
		const recursiveFixed = await run({ command: `textgrep -R -F 'critical' ${folder}` });
		expect(recursiveFixed.metadata.exitCode).toBe(2);
		expect(recursiveFixed.stderr).toContain("does not support exact fixed-string");

		// None of the rejected/guidance forms above reached indexed full-text search.
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("meta searches indexed frontmatter and inspects one file", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{
					path: "/docs/meta-email.md",
					content:
						"---\nfrom: alice@example.com\ncc:\n  - Bob\n  - Jane\namount: 125\nreviewed: true\nsentAt: 2026-07-29T14:30:00Z\n---\n# Email\n",
				},
				{
					path: "/docs/meta-tags.md",
					content: "---\ntopic:\n  - alpha\n  - atlas\n---\n# Tags\n",
				},
			],
		});

		const paths = await run({
			command: `meta search --where '{"eq":["frontmatter.from","alice@example.com"]}' --limit 5`,
		});
		const json = await run({
			command: `meta search --format json --where '{"range":["frontmatter.amount",{"gte":100}]}'`,
		});
		const jsonExists = await run({ command: `meta search --format json --where '{"exists":"frontmatter.cc"}'` });
		const jsonDateRange = await run({
			command: `meta search --format json --where '{"range":["frontmatter.sentAt",{"gte":"2026-07-27","lt":"2026-08-02"}]}'`,
		});
		const dedupedPrefix = await run({
			command: `meta search --where '{"prefix":["frontmatter.topic","a"]}' --limit 5`,
		});
		const scoped = await run({
			command: `cd ${test_db_files_mount}/docs && meta search --where '{"exists":"frontmatter.cc"}'`,
		});
		const get = await run({ command: `meta get ${test_db_files_mount}/docs/meta-email.md` });
		const invalid = await run({ command: `meta search --where '{"eq":["from","alice@example.com"]}'` });

		expect(paths.metadata.exitCode).toBe(0);
		expect(paths.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
		expect(paths.stderr).toBe("");
		expect(
			runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_visible:internal_search_metadata_saved" &&
					(args as { plan?: unknown }).plan != null,
			),
		).toBe(true);

		expect(json.metadata.exitCode).toBe(0);
		expect(json.stderr).toBe("");
		const parsedJson = JSON.parse(json.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
			nextCursor: string | null;
		};
		expect(parsedJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.amount",
				valueKind: "number",
				matchedValue: 125,
			}),
		]);
		expect(parsedJson.nextCursor).toBeNull();

		expect(jsonExists.metadata.exitCode).toBe(0);
		expect(jsonExists.stderr).toBe("");
		const parsedExistsJson = JSON.parse(jsonExists.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue?: unknown }>;
		};
		expect(parsedExistsJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.cc",
				valueKind: "none",
			}),
		]);
		expect(parsedExistsJson.results[0]).not.toHaveProperty("matchedValue");

		expect(jsonDateRange.metadata.exitCode).toBe(0);
		expect(jsonDateRange.stderr).toBe("");
		const parsedDateRangeJson = JSON.parse(jsonDateRange.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
		};
		// Confirm that string bounds match the maybe_date companion doc and render as an ISO string.
		expect(parsedDateRangeJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.sentAt",
				valueKind: "maybe_date",
				matchedValue: "2026-07-29T14:30:00.000Z",
			}),
		]);

		expect(dedupedPrefix.metadata.exitCode).toBe(0);
		expect(dedupedPrefix.stderr).toBe("");
		expect(dedupedPrefix.stdout).toBe(`${test_db_files_mount}/docs/meta-tags.md\n`);

		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
		expect(
			runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_visible:internal_search_metadata_saved" &&
					(args as { folderPath?: string }).folderPath === "/docs",
			),
		).toBe(true);

		expect(get.metadata.exitCode).toBe(0);
		expect(get.stdout).toContain("source: committed");
		expect(get.stdout).toContain("frontmatter.cc");
		expect(get.stdout).toContain('frontmatter.from = "alice@example.com"');
		// A date-like string produces two lines. Only the maybe_date line carries the marker, so the
		// agent can tell them apart and see that the field supports range filters.
		expect(get.stdout).toContain('frontmatter.sentAt = "2026-07-29T14:30:00Z"\n');
		expect(get.stdout).toContain('frontmatter.sentAt = "2026-07-29T14:30:00.000Z" (maybe_date)');

		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("must be qualified");
	});

	test("meta search with a folder keeps rows under it and finds a folder moved into it", async () => {
		const topic = "---\ntopic: atlas\n---\n# Topic\n";
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/meta-in.md", content: topic },
				{ path: "/reports/meta-out.md", content: topic },
				{ path: "/outside/inner/meta-moved.md", content: topic },
			],
		});
		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/outside/inner ${test_db_files_mount}/docs/inner`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// `eq` reads the folder's own rows, then the rows under the folder moved into it.
		const eq = await runner.run({
			command: `meta search --path ${test_db_files_mount}/docs --where '{"eq":["frontmatter.topic","atlas"]}'`,
		});
		expect(eq.stderr).toBe("");
		expect(eq.stdout.split("\n").filter(Boolean).sort()).toEqual([
			`${test_db_files_mount}/docs/inner/meta-moved.md`,
			`${test_db_files_mount}/docs/meta-in.md`,
		]);

		// `prefix` reads the whole workspace and drops the rows outside the folder.
		const prefix = await runner.run({
			command: `meta search --path ${test_db_files_mount}/docs --where '{"prefix":["frontmatter.topic","at"]}'`,
		});
		expect(prefix.stderr).toBe("");
		expect(prefix.stdout.split("\n").filter(Boolean).sort()).toEqual([
			`${test_db_files_mount}/docs/inner/meta-moved.md`,
			`${test_db_files_mount}/docs/meta-in.md`,
		]);
	});

	test("meta search shows a row once when a folder inside a moved-in folder is renamed", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/outside/g/k/meta-target.md", content: "---\ntopic: atlas\n---\n# Topic\n" }],
		});
		for (const command of [
			`mv ${test_db_files_mount}/outside/g ${test_db_files_mount}/docs/g`,
			`mv ${test_db_files_mount}/docs/g/k ${test_db_files_mount}/docs/g/k2`,
		])
			expect((await runner.run({ command })).metadata.exitCode).toBe(0);

		// One row per page: the dedupe inside one call cannot hide a row that two streams return.
		const paths: string[] = [];
		let command: string | null =
			`meta search --path ${test_db_files_mount}/docs --where '{"eq":["frontmatter.topic","atlas"]}' --limit 1`;
		for (let page = 0; command !== null && page < 10; page++) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode).toBe(0);
			paths.push(...result.stdout.split("\n").filter(Boolean));
			// meta search prints its Next page command on stderr.
			command = result.stderr.startsWith("Next page: ") ? result.stderr.trim().slice("Next page: ".length) : null;
		}
		expect(paths).toEqual([`${test_db_files_mount}/docs/g/k2/meta-target.md`]);
	});

	test("reads and searches a folder map written by the metadata tool", async () => {
		const runner = await create_bash_runner();
		const tool = ai_chat_tool_create_set_file_metadata(runner.ctx, {
			...runner.ctxData,
			getThreadId: () => runner.threadId,
			getRun: () => runner.chatRun,
		});
		const written = await tool.execute?.(
			{
				workspace: "current",
				path: "/docs",
				set: [
					{ key: "plugin-name", value: "chitchat" },
					{ key: "reviewed", value: false },
				],
				remove: [],
			},
			{ toolCallId: "folder-metadata", messages: [] },
		);
		expect(written).toMatchObject({ metadata: { path: "/docs" } });

		const get = await runner.run({ command: `meta get ${test_db_files_mount}/docs` });
		expect(get.metadata.exitCode).toBe(0);
		expect(get.stdout).toContain('metadata.plugin-name = "chitchat"');
		expect(get.stdout).toContain("metadata.reviewed = false");
		expect(get.stdout).not.toContain("frontmatter.");
		const json = await runner.run({ command: `meta get ${test_db_files_mount}/docs --format json` });
		expect(json.metadata.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			path: `${test_db_files_mount}/docs`,
			fields: ["metadata.plugin-name", "metadata.reviewed"],
			values: [
				{ field: "metadata.plugin-name", valueKind: "string", value: "chitchat" },
				{ field: "metadata.reviewed", valueKind: "boolean", value: false },
			],
		});
		const search = await runner.run({ command: `meta search --where '{"eq":["metadata.plugin-name","chitchat"]}'` });
		expect(search.metadata.exitCode).toBe(0);
		expect(search.stdout).toBe(`${test_db_files_mount}/docs\n`);

		await tool.execute?.(
			{ workspace: "current", path: "/docs", set: [], remove: ["plugin-name", "reviewed"] },
			{ toolCallId: "remove-folder-metadata", messages: [] },
		);
		const empty = await runner.run({ command: `meta get ${test_db_files_mount}/docs --format json` });
		expect(empty.metadata.exitCode).toBe(0);
		expect(JSON.parse(empty.stdout)).toMatchObject({ fields: [], values: [] });
	});

	test("does not scan markdown files when indexed search misses", async () => {
		const { run, runAction } = await create_bash_runner();

		const result = await run({ command: "search --limit 5 zzz-absent-token" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("No content matches found");
		expect(result.stdout).toContain("find -name QUERY");
		expect(result.stdout).toContain("meta search");
		expect(runAction).not.toHaveBeenCalled();
	});

	test("rejects chunk-type filters for indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const code = await run({ command: "search --code code-token" });
		const table = await run({ command: "search --table table-token" });
		const noCode = await run({ command: "search --no-code unique-token" });

		expect(code.metadata.exitCode).toBe(2);
		expect(table.metadata.exitCode).toBe(2);
		expect(noCode.metadata.exitCode).toBe(2);
		expect(code.stderr).toContain("--code is not supported");
		expect(table.stderr).toContain("--table is not supported");
		expect(noCode.stderr).toContain("--no-code is not supported");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("maps simple recursive app grep to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `grep -R unique-token ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("uses indexed full-text search");
		expect(result.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);
	});

	test("rejects grep -R -F over an app folder instead of routing to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `grep -R -F unique-token ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("does not support exact fixed-string");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("annotates broad full-text results for exact hyphenated grep -R patterns", async () => {
		// Same intraword-bold trick as the search annotation tests: the index matches broad.md
		// but its markdown chunk lacks the literal token, so its hit carries the word-level note.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/grep-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
			],
		});

		const result = await run({ command: `grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Found 2 results under ${test_db_files_mount}/grep-fixtures (exact matches: 1, word-level-only matches: 1; see per-hit notes)`,
		);
		expect(result.stdout).toMatch(/grep-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		expect(result.stdout).toMatch(
			/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("keeps a grep -R page whose hits are only word-level matches", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" }],
		});

		const result = await run({ command: `grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Found 1 results under ${test_db_files_mount}/grep-fixtures (exact matches: 0, word-level-only matches: 1; see per-hit notes)`,
		);
		expect(result.stdout).toMatch(
			/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("greps a single app file (regex by default, -F substring, optional line numbers, -i), guidance otherwise", async () => {
		const { run } = await create_bash_runner();

		// Single app file prints raw matching lines by default, like native grep.
		const hit = await run({ command: `grep unique-token ${test_db_files_mount}/docs/readme.md` });
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stdout).toBe("unique-token here\nmore unique-token below\n");

		// Single-file app grep supports regex because it scans one bounded chunk stream.
		const regexHit = await run({ command: `grep 'unique.*below' ${test_db_files_mount}/docs/readme.md` });
		expect(regexHit.metadata.exitCode).toBe(0);
		expect(regexHit.stdout).toBe("more unique-token below\n");

		const invalidRegex = await run({ command: `grep '[' ${test_db_files_mount}/docs/readme.md` });
		expect(invalidRegex.metadata.exitCode).toBe(2);
		expect(invalidRegex.stderr).toContain("invalid regex");

		// -F switches back to fixed-string semantics.
		const fixedMiss = await run({ command: `grep -F 'unique.*below' ${test_db_files_mount}/docs/readme.md` });
		expect(fixedMiss.metadata.exitCode).toBe(1);
		expect(fixedMiss.stdout).toBe("");

		// -n switches to 1-based line numbers.
		const numberedHit = await run({ command: `grep -n unique-token ${test_db_files_mount}/docs/readme.md` });
		expect(numberedHit.metadata.exitCode).toBe(0);
		expect(numberedHit.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

		const dashPattern = await run({ command: `grep -- -token ${test_db_files_mount}/docs/readme.md` });
		expect(dashPattern.metadata.exitCode).toBe(0);
		expect(dashPattern.stdout).toBe("unique-token here\nmore unique-token below\n");

		const piped = await run({
			command: `cat ${test_db_files_mount}/docs/readme.md | head -n 20 | grep -n unique-token`,
		});
		expect(piped.metadata.exitCode).toBe(0);
		expect(piped.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

		const pipedRegex = await run({ command: `cat ${test_db_files_mount}/docs/readme.md | grep 'unique.*below'` });
		expect(pipedRegex.metadata.exitCode).toBe(0);
		expect(pipedRegex.stdout).toBe("more unique-token below\n");

		const pipedFixedMiss = await run({
			command: `cat ${test_db_files_mount}/docs/readme.md | grep -F 'unique.*below'`,
		});
		expect(pipedFixedMiss.metadata.exitCode).toBe(1);
		expect(pipedFixedMiss.stdout).toBe("");

		// Case-insensitive.
		const ci = await run({ command: `grep -i ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(ci.metadata.exitCode).toBe(0);
		expect(ci.stdout).toBe("alpha\nALPHA\n");

		// No match → exit 1, no output (real grep semantics).
		const none = await run({ command: `grep zzz-nope ${test_db_files_mount}/docs/readme.md` });
		expect(none.metadata.exitCode).toBe(1);
		expect(none.stdout).toBe("");

		// Multiple files → falls back to guidance (we only handle one file).
		const multi = await run({
			command: `grep token ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(multi.metadata.exitCode).toBe(2);
		expect(multi.stdout).toContain("is not supported");

		const unsupportedSingleFileFlag = await run({ command: `grep -o token ${test_db_files_mount}/docs/readme.md` });
		expect(unsupportedSingleFileFlag.metadata.exitCode).toBe(2);
		expect(unsupportedSingleFileFlag.stderr).toContain("unsupported option -o");
		expect(unsupportedSingleFileFlag.stderr).toContain("Supported: grep [-n] [-i] [-F]");

		// -c counts matching lines ("token" is on lines 2 and 3).
		const counted = await run({ command: `grep -c token ${test_db_files_mount}/docs/readme.md` });
		expect(counted.metadata.exitCode).toBe(0);
		expect(counted.stdout).toBe("2\n");

		// Multiple -e patterns (OR semantics we don't reproduce) → guidance, not a silent
		// single-pattern match.
		const multiE = await run({ command: `grep -e token -e other ${test_db_files_mount}/docs/readme.md` });
		expect(multiE.metadata.exitCode).toBe(2);

		// Combined short flags: -in (= -i -n) takes the single-file fast path, case-insensitively.
		const combined = await run({ command: `grep -in ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(combined.metadata.exitCode).toBe(0);
		expect(combined.stdout).toBe("2:alpha\n3:ALPHA\n");

		const fixedCombined = await run({ command: `grep -Fin alpha ${test_db_files_mount}/docs/tutorial.md` });
		expect(fixedCombined.metadata.exitCode).toBe(0);
		expect(fixedCombined.stdout).toBe("2:alpha\n3:ALPHA\n");

		// -iv (= -i -v) inverts: only line 1 lacks "token" (case-insensitively).
		const combinedV = await run({ command: `grep -iv token ${test_db_files_mount}/docs/readme.md` });
		expect(combinedV.metadata.exitCode).toBe(0);
		expect(combinedV.stdout).toBe("# Readme\n");

		// -l prints the file path when it has a match, and exits 1 (no output) when it does not.
		const listed = await run({ command: `grep -l unique-token ${test_db_files_mount}/docs/readme.md` });
		expect(listed.metadata.exitCode).toBe(0);
		expect(listed.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
		const listedNone = await run({ command: `grep -l zzz-nope ${test_db_files_mount}/docs/readme.md` });
		expect(listedNone.metadata.exitCode).toBe(1);
		expect(listedNone.stdout).toBe("");

		// -B N adds leading context. Without -n, both matching and context lines are raw text.
		const before = await run({ command: `grep -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(before.metadata.exitCode).toBe(0);
		expect(before.stdout).toBe("alpha\nALPHA\n");

		// With -n, context lines use "-" and selected lines use ":".
		const beforeNumbered = await run({ command: `grep -n -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(beforeNumbered.metadata.exitCode).toBe(0);
		expect(beforeNumbered.stdout).toBe("2-alpha\n3:ALPHA\n");

		// -v without context stays native-like: non-contiguous selected lines are printed directly.
		const invertGap = await run({ command: `grep -v alpha ${test_db_files_mount}/docs/tutorial.md` });
		expect(invertGap.metadata.exitCode).toBe(0);
		expect(invertGap.stdout).toBe("zeta\nALPHA\n");

		const pipedInvertGap = await run({ command: `cat ${test_db_files_mount}/docs/tutorial.md | grep -v alpha` });
		expect(pipedInvertGap.metadata.exitCode).toBe(0);
		expect(pipedInvertGap.stdout).toBe("zeta\nALPHA\n");
	});

	test("supports app grep line and slice continuation windows", async () => {
		const latePath = "/docs/late-grep.md";
		const longPath = "/docs/long-line-grep.md";
		const longPrefix = "x".repeat(256 * 1024);
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: latePath,
					content: ["first line", "late-window-token", "third line"].join("\n"),
				},
				{
					path: longPath,
					content: `${longPrefix}needle-after-long-prefix\n`,
				},
			],
		});

		const lineWindow = await run({
			command: `grep --start-line 3 --max-lines 1 unique-token ${test_db_files_mount}/docs/readme.md`,
		});
		expect(lineWindow.metadata.exitCode).toBe(0);
		expect(lineWindow.stdout).toBe("more unique-token below\n");

		const capped = await run({
			command: `grep --start-line 1 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		});
		expect(capped.metadata.exitCode).toBe(1);
		expect(capped.stdout).toBe("");
		expect(capped.stderr).toContain("line scan cap reached");
		expect(capped.stderr).toContain(
			`Next scan: grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		);

		const continued = await run({
			command: `grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		});
		expect(continued.metadata.exitCode).toBe(0);
		expect(continued.stdout).toBe("late-window-token\n");

		const byteCapped = await run({ command: `grep needle-after-long-prefix ${test_db_files_mount}${longPath}` });
		expect(byteCapped.metadata.exitCode).toBe(1);
		expect(byteCapped.stdout).toBe("");
		expect(byteCapped.stderr).toContain("byte scan cap reached");
		const byteContinuationCommand = byteCapped.stderr.match(
			/Next scan: (grep --start-index 0 --max-chars \d+ needle-after-long-prefix [^\n]+)/u,
		)?.[1];
		expect(byteContinuationCommand?.startsWith("grep --start-index 0 --max-chars ")).toBe(true);
		expect(byteContinuationCommand).toContain(` needle-after-long-prefix ${test_db_files_mount}${longPath}`);

		const slice = await run({
			command: `grep --start-index ${longPrefix.length - 8} --max-chars 128 needle-after-long-prefix ${test_db_files_mount}${longPath}`,
		});
		expect(slice.metadata.exitCode).toBe(0);
		expect(slice.stdout).toBe(`xxxxxxxxneedle-after-long-prefix\n`);
		expect(slice.stderr).toContain("slice mode scans a text slice");
	});

	test("uses regex for single-file app grep patterns that look like regex", async () => {
		const { run } = await create_bash_runner();

		const anchored = await run({ command: `grep '^# Readme' ${test_db_files_mount}/docs/readme.md` });
		const wildcard = await run({ command: `grep 'unique.*token' ${test_db_files_mount}/docs/readme.md` });
		const fixed = await run({ command: `grep -F '^# Readme' ${test_db_files_mount}/docs/readme.md` });

		expect(anchored.metadata.exitCode).toBe(0);
		expect(anchored.stdout).toBe("# Readme\n");
		expect(anchored.stderr).toBe("");
		expect(wildcard.metadata.exitCode).toBe(0);
		expect(wildcard.stdout).toBe("unique-token here\nmore unique-token below\n");
		expect(fixed.metadata.exitCode).toBe(1);
		expect(fixed.stdout).toBe("");
		expect(fixed.stderr).toBe("");
	});

	test("warns when app grep output is capped", async () => {
		const path = "/docs/capped-grep.md";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path,
					content: Array.from({ length: 105 }, (_, index) => `cap-token ${index + 1}`).join("\n"),
				},
			],
		});

		const capped = await run({ command: `grep cap-token ${test_db_files_mount}${path}` });

		expect(capped.metadata.exitCode).toBe(0);
		expect(capped.stdout.split("\n").filter(Boolean)).toHaveLength(100);
		expect(capped.stderr).toContain("match cap reached");
		expect(capped.stderr).toContain("Next scan:");
	});

	test("treats chunk-unavailable app grep as no match", async () => {
		const path = "/docs/large-grep.md";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path,
					content: `match-token\n${"filler-line\n".repeat(800)}`,
					brokenChunks: true,
				},
			],
		});
		const shellPath = `${test_db_files_mount}${path}`;

		const match = await run({ command: `grep match-token ${shellPath}` });
		const noMatch = await run({ command: `grep missing-token ${shellPath}` });

		for (const result of [match, noMatch]) {
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		}
		expect(noMatch.stdout).toBe("");
	});

	test("uses prefix find and renders app tree pages", async () => {
		const { run } = await create_bash_runner();
		const scopedRunner = await create_bash_runner({
			initialCwd: `${test_db_files_mount}/docs`,
			extraFiles: [{ path: "/docs/nested/more.md", content: "more\n" }],
		});

		const prefixResult = await run({ command: "find --prefix /docs --limit 20 -type f" });
		const relativePrefixResult = await scopedRunner.run({ command: "find --prefix nested --limit 1" });
		const treeResult = await run({ command: `tree ${test_db_files_mount}/docs --limit 2` });

		expect(prefixResult.metadata.exitCode).toBe(0);
		expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
		expect(relativePrefixResult.metadata.exitCode).toBe(0);
		expect(relativePrefixResult.stdout).toMatch(
			new RegExp(`Next page: find --prefix ${test_db_files_mount}/docs/nested --limit 1 --cursor \\S+`, "u"),
		);
		expect(treeResult.metadata.exitCode).toBe(0);
		expect(treeResult.stdout).toContain(test_db_files_mount + "/docs");
		expect(treeResult.stdout).toContain("|-- nested/");
		expect(treeResult.stdout).toContain("|   |-- deep.md");
		expect(treeResult.stdout).toMatch(
			new RegExp(`Next page: tree ${test_db_files_mount}/docs --limit 2 --cursor \\S+`, "u"),
		);
	});

	test("tree continuation pages remind agents to stop after one requested continuation", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/tree-stop/a.md", content: "a\n" },
				{ path: "/tree-stop/b.md", content: "b\n" },
				{ path: "/tree-stop/c.md", content: "c\n" },
			],
		});

		const firstPage = await run({ command: `tree ${test_db_files_mount}/tree-stop --limit 1` });
		const continuation = firstPage.stdout.match(/Next page: (tree .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a tree continuation in the first page stdout");
		}

		const secondPage = await run({ command: continuation });

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("Next page: tree");
		expect(secondPage.stdout).toContain("if the user asked for exactly one continuation, stop here");
	});

	test("renders exact file tree targets without subtree pagination", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `tree ${test_db_files_mount}/docs/readme.md --limit 2` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
	});

	test("keeps tree app-only option guidance out of /tmp paths", async () => {
		const { run, runQuery } = await create_bash_runner();

		const nativeJustBashResult = await run({
			command: "mkdir -p /tmp/tree-tmp && printf hi > /tmp/tree-tmp/a.md && tree -P '*.md' /tmp/tree-tmp",
		});
		const appResult = await run({ command: `tree -P '*.md' ${test_db_files_mount}/docs` });
		const nativeJustBashNextPage = await run({ command: "tree --next-page /tmp" });
		const appNextPage = await run({ command: `tree --next-page ${test_db_files_mount}/docs` });

		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		expect(appResult.metadata.exitCode).toBe(2);
		expect(appResult.stderr).toContain("unsupported option -P");
		expect(appResult.stderr).toContain("/home/cloud-usr/w");
		for (const result of [nativeJustBashNextPage, appNextPage]) {
			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
		}
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports exact reader commands while keeping unreadable app content out of generic readers", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: [
				`head -n 1 ${test_db_files_mount}/docs/readme.md`,
				`tail -n +2 ${test_db_files_mount}/docs/readme.md`,
				`wc -c ${test_db_files_mount}/docs/readme.md`,
				`stat -c "%F %n" ${test_db_files_mount}/docs/readme.md`,
			].join(" && "),
		});
		const unreadableHead = await run({ command: `head ${test_db_files_mount}/source.pdf` });
		const unreadableTail = await run({ command: `tail ${test_db_files_mount}/source.pdf` });
		const unreadableWc = await run({ command: `wc ${test_db_files_mount}/source.pdf` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(result.stdout).toContain("unique-token");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).toContain("regular file");
		for (const unreadable of [unreadableHead, unreadableTail, unreadableWc]) {
			expect(unreadable.metadata.exitCode).toBe(1);
			expect(unreadable.stdout).toBe("");
			expect(unreadable.stderr).toContain("Bash can read editable text files only");
			expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		}
	});

	test("supports stat long format options and dash-leading operands after --", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const shortFormat = await run({ command: `stat -c "%F %n" ${readmePath}` });
		const longFormat = await run({ command: `stat --format "%F %n" ${readmePath}` });
		const equalsFormat = await run({ command: `stat --format=%F ${readmePath}` });
		const literalPercent = await run({ command: `stat -c "%% %F" ${readmePath}` });
		const dashLeadingTmp = await run({ command: "printf hi > /tmp/-dash-stat && stat -- /tmp/-dash-stat" });

		expect(shortFormat.metadata.exitCode).toBe(0);
		expect(longFormat.metadata.exitCode).toBe(0);
		expect(equalsFormat.metadata.exitCode).toBe(0);
		expect(literalPercent.metadata.exitCode).toBe(0);
		expect(dashLeadingTmp.metadata.exitCode).toBe(0);
		expect(longFormat.stdout).toBe(shortFormat.stdout);
		expect(equalsFormat.stdout).toBe("regular file\n");
		expect(literalPercent.stdout).toBe("% regular file\n");
		expect(dashLeadingTmp.stdout).toContain("File: /tmp/-dash-stat");
		expect(dashLeadingTmp.stdout).not.toContain("app files track");
	});

	test("warns about unsupported app stat format tokens without changing stdout", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const appResult = await run({ command: `stat -c "%i %b %s %%" ${readmePath}` });
		const tmpResult = await run({
			command: 'printf hi > /tmp/stat-format.txt && stat -c "%i %b %s %%" /tmp/stat-format.txt',
		});

		expect(appResult.metadata.exitCode).toBe(0);
		expect(appResult.stdout).toContain("%i %b ");
		expect(appResult.stdout).toContain(" %\n");
		expect(appResult.stderr).toContain("app files support only");
		expect(appResult.stderr).toContain("inode, blocks, device, and filesystem fields are not tracked");
		expect(tmpResult.metadata.exitCode).toBe(0);
		expect(tmpResult.stderr).not.toContain("app files support only");
	});

	test("does not recursively expand stat format tokens introduced by file names", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/docs/%s-%F.md", content: "token name\n" }],
		});
		const tokenPath = `${test_db_files_mount}/docs/%s-%F.md`;

		const result = await run({ command: `stat -c "%n" '${tokenPath}'` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${tokenPath}\n`);
	});

	test("keeps stat glob guidance scoped to app paths", async () => {
		const { run } = await create_bash_runner();

		const tmpGlob = await run({ command: "printf hi > '/tmp/star*.txt' && stat '/tmp/star*.txt'" });
		const appGlob = await run({ command: `stat '${test_db_files_mount}/docs/*.md'` });

		expect(tmpGlob.metadata.exitCode).toBe(0);
		expect(tmpGlob.stdout).toContain("File: /tmp/star*.txt");
		expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
		expect(appGlob.metadata.exitCode).not.toBe(0);
		expect(appGlob.stderr).toContain("app file glob patterns are not supported");
		expect(appGlob.stderr).toContain("find");
	});

	test("renders app stat metadata without fake block counts", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `stat ${test_db_files_mount}/docs/readme.md` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("  Size: ");
		expect(result.stdout).not.toContain("Blocks:");
		expect(result.stdout).toContain("not POSIX permissions, owner, group, inode, or blocks");
	});

	test("stat reports non-editable asset size through the shared size helper", async () => {
		const { run, runQuery } = await create_bash_runner();
		const sourcePath = `${test_db_files_mount}/source.pdf`;
		runQuery.mockClear();

		const result = await run({ command: `stat -c %s ${sourcePath}` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("4096\n");
		expect(runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toHaveLength(1);
	});

	test("stat reports unsaved edit size before the committed asset size", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/draft-stat.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const draftNodeId = await get_seeded_node_id(runner, "/draft-stat.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: draftNodeId },
			unstagedText: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: draftNodeId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /draft-stat.md");
		}
		const draftPath = `${test_db_files_mount}/draft-stat.md`;
		runner.runQuery.mockClear();

		const result = await runner.run({ command: `stat -c %s ${draftPath}` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${pendingUpdate.size}\n`);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("stat reports the committed size after a pure move", async () => {
		const runner = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigNode = await get_seeded_node(runner, "/big.md");
		if (bigNode.assetId == null) {
			throw new Error("expected /big.md to have a committed asset");
		}
		const asset = await runner.t.query(internal.r2.get_asset_by_id, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			assetId: bigNode.assetId,
		});
		if (asset?.size == null) {
			throw new Error("expected a committed asset size for /big.md");
		}
		expect(asset.size).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);

		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/big.md ${test_db_files_mount}/renamed-big.md`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc stores size 0; stat must report the committed asset size, not 0.
		const result = await runner.run({ command: `stat -c %s ${test_db_files_mount}/renamed-big.md` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${asset.size}\n`);
	});

	test("rejects stat format options without a value", async () => {
		const { run } = await create_bash_runner();

		const shortFormat = await run({ command: "stat -c" });
		const longFormat = await run({ command: "stat --format" });

		expect(shortFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(longFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(shortFormat.stderr).toContain("stat: -c requires a value");
		expect(longFormat.stderr).toContain("stat: --format requires a value");
		expect(shortFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
		expect(longFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
	});

	describe("shells", () => {
		const transcript_of = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, name: string) => {
			const shell = await get_shell({ t: runner.t, threadId: runner.threadId, name });
			if (!shell) throw new Error(`Expected shell ${name}`);
			const entries = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shell_transcripts")
					.withIndex("by_shell_seq", (q) => q.eq("shellId", shell._id))
					.collect(),
			);
			return { shell, entries };
		};

		const transcript_reads = (runner: Awaited<ReturnType<typeof create_bash_runner>>) =>
			runner.runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "ai_chat_files:read_shell_transcript")
				.length;

		test("creates a named shell and runs the command in one call", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({ command: "pwd", toolCallId: undefined, shellName: "work" });
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}\n`);
			const shells = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", runner.threadId))
					.collect(),
			);
			expect(shells.map((shell) => shell.name)).toEqual(["work"]);
		});

		test("refuses the 11th shell and names the existing ones", async () => {
			const runner = await create_bash_runner();
			for (let i = 0; i < 10; i++) {
				expect(
					(await runner.run({ command: "true", toolCallId: undefined, shellName: `s${i}` })).metadata.exitCode,
				).toBe(0);
			}
			await expect(runner.run({ command: "true", toolCallId: undefined, shellName: "s10" })).rejects.toThrow(
				"This thread already has 10 shells (s0, s1, s2, s3, s4, s5, s6, s7, s8, s9). Reuse one of them.",
			);
			const shells = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", runner.threadId))
					.collect(),
			);
			expect(shells).toHaveLength(10);
		});

		test("keeps a variable for the next call in the same shell only", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "x=5" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo $x" })).stdout).toBe("5\n");
			expect((await runner.run({ command: "echo $x", toolCallId: undefined, shellName: "other" })).stdout).toBe("\n");
		});

		test("keeps the saved state when the call leaves cwd inside /tmp", async () => {
			const runner = await create_bash_runner();

			// /tmp is per-thread scratch with its own caps, so a cwd left there is the case most
			// likely to lose the rest of the shell state on the way back.
			expect(
				(await runner.run({ command: "kept=yes; fruits=(apple pear); mkdir -p /tmp/scratch-cwd; cd /tmp/scratch-cwd" }))
					.metadata.exitCode,
			).toBe(0);

			const read = await runner.run({ command: 'printf "%s|%s|%s\\n" "$kept" "${#fruits[@]}" "$(pwd)"' });
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe("yes|2|/tmp/scratch-cwd\n");
		});

		test("keeps an indexed and an associative array for the next call", async () => {
			const runner = await create_bash_runner();

			// Arrays live outside env in the engine state, so they need their own place in the saved
			// snapshot. Without it a later call sees the names as unset.
			expect(
				(await runner.run({ command: "fruits=(apple pear plum); declare -A ages; ages[ana]=31" })).metadata.exitCode,
			).toBe(0);

			const read = await runner.run({ command: 'printf "%s|%s|%s\\n" "${fruits[1]}" "${#fruits[@]}" "${ages[ana]}"' });
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe("pear|3|31\n");

			// A different shell in the same thread starts without them.
			expect(
				(await runner.run({ command: 'printf "%s\\n" "${#fruits[@]}"', toolCallId: undefined, shellName: "other" }))
					.stdout,
			).toBe("0\n");
		});

		test("still saves the variable when the call ends with exit 0", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "x=5; exit 0" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo $x" })).stdout).toBe("5\n");
		});

		test("keeps a function for the next call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "hi() { echo hi from $1; }" })).metadata.exitCode).toBe(0);
			const called = await runner.run({ command: "hi later" });
			expect(called.metadata.exitCode, called.stderr).toBe(0);
			expect(called.stdout).toBe("hi from later\n");
		});

		test("keeps set -e for the next call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "set -e" })).metadata.exitCode).toBe(0);
			const stopped = await runner.run({ command: "false; echo after" });
			expect(stopped.metadata.exitCode).toBe(1);
			expect(stopped.stdout).toBe("");
		});

		test("an Ask-mode call still saves the snapshot into the shared shell", async () => {
			const runner = await create_bash_runner({ allowDbFilesMkdir: false });
			expect((await runner.run({ command: "x=5; f() { echo fn; }" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo $x; f" })).stdout).toBe("5\nfn\n");
		});

		test("cd in one shell does not move another", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "cd docs", toolCallId: undefined, shellName: "a" })).metadata.nextCwd).toBe(
				`${test_db_files_mount}/docs`,
			);
			expect((await runner.run({ command: "pwd", toolCallId: undefined, shellName: "b" })).stdout).toBe(
				`${test_db_files_mount}\n`,
			);
			expect((await runner.run({ command: "pwd", toolCallId: undefined, shellName: "a" })).stdout).toBe(
				`${test_db_files_mount}/docs\n`,
			);
		});

		test("warns about a file descriptor left open and does not restore it", async () => {
			const runner = await create_bash_runner();
			const opened = await runner.run({ command: "exec 3>/tmp/fd.txt; echo hi" });
			expect(opened.metadata.exitCode).toBe(0);
			expect(opened.stderr).toContain("bash: file descriptor 3 was closed\n");
			const reused = await runner.run({ command: "echo again >&3" });
			expect(reused.metadata.exitCode).not.toBe(0);
			expect(reused.stderr).toMatch(/bad file descriptor/i);
		});

		test("does not save a snapshot over 128 KiB and keeps the previous state", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "x=1" })).metadata.exitCode).toBe(0);
			const grown = await runner.run({ command: "big=a; for i in $(seq 18); do big=$big$big; done; echo ${#big}" });
			expect(grown.metadata.exitCode, grown.stderr).toBe(0);
			expect(grown.stdout).toBe("262144\n");
			expect(grown.stderr).toContain(
				"bash: the shell state is larger than 128 KiB and was not saved; the previous state stays.\n",
			);
			expect((await runner.run({ command: "echo ${#big} $x" })).stdout).toBe("0 1\n");
		});

		test("appends one transcript entry per call, in order, with the header", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo one" });
			await runner.run({ command: "cd docs; echo two; echo err >&2" });
			const { shell, entries } = await transcript_of(runner, "default");
			expect(entries.map((entry) => entry.seq)).toEqual([0, 1]);
			expect(entries[0]!.text).toMatch(
				new RegExp(`^\\$ \\[\\d{4}-\\d\\d-\\d\\dT[^\\]]+Z\\] \\(exit 0\\) ${test_db_files_mount}\necho one\none\n\n$`),
			);
			expect(entries[1]!.text).toMatch(
				new RegExp(
					`^\\$ \\[[^\\]]+\\] \\(exit 0\\) ${test_db_files_mount}\ncd docs; echo two; echo err >&2\ntwo\n\nerr\n$`,
				),
			);
			expect(shell).toMatchObject({
				transcriptEntries: 2,
				transcriptSeq: 2,
				transcriptBytes: entries[0]!.bytes + entries[1]!.bytes,
			});
		});

		test("output with half a character reaches the result and the transcript as U+FFFD", async () => {
			const runner = await create_bash_runner();
			// A character outside the basic range is two code units, and `printf` can write one of them
			// on its own. Convex refuses a mutation argument that holds such a string, so the whole call
			// used to fail with "Invalid arguments provided" and the model saw no output at all.
			const result = await runner.run({ command: `printf 'A\\ud83cB'` });
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("A�B");
			const { entries } = await transcript_of(runner, "default");
			expect(entries[0]!.text).toContain("A�B");
			expect(entries[0]!.text.isWellFormed()).toBe(true);
		});

		test("mounts the transcripts read-only under /shells and reads one only when asked", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "echo hi", toolCallId: undefined, shellName: "a" })).metadata.exitCode).toBe(
				0,
			);
			const listed = await runner.run({ command: "ls /shells", toolCallId: undefined, shellName: "b" });
			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(listed.stdout).toBe("a\nb\n");
			expect(transcript_reads(runner)).toBe(0);

			const detailed = await runner.run({ command: "ls -l /shells/a", toolCallId: undefined, shellName: "b" });
			expect(detailed.metadata.exitCode, detailed.stderr).toBe(0);
			expect(detailed.stdout).toContain("transcript");
			expect(transcript_reads(runner)).toBe(1);

			const read = await runner.run({ command: "cat /shells/a/transcript", toolCallId: undefined, shellName: "b" });
			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toContain("echo hi\nhi\n");
			expect(transcript_reads(runner)).toBe(2);

			const written = await runner.run({
				command: "echo x > /shells/a/transcript",
				toolCallId: undefined,
				shellName: "b",
			});
			expect(written.metadata.exitCode).not.toBe(0);
			expect(written.stderr).toMatch(/read-only/i);
			expect(
				(await runner.run({ command: "rm /shells/a/transcript", toolCallId: undefined, shellName: "b" })).metadata
					.exitCode,
			).not.toBe(0);
			expect((await transcript_of(runner, "a")).entries).toHaveLength(1);
		});

		test("persists cd /shells/<name>", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "true", toolCallId: undefined, shellName: "a" })).metadata.exitCode).toBe(0);
			const entered = await runner.run({ command: "cd /shells/a" });
			expect(entered.metadata.exitCode, entered.stderr).toBe(0);
			expect(entered.metadata.nextCwd).toBe("/shells/a");
			expect(entered.stderr).toBe("");
			expect((await runner.run({ command: "pwd" })).stdout).toBe("/shells/a\n");
		});

		test("a replayed call with another shell is refused, and a job: id never reaches the lookup", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "pwd", toolCallId: "same-call", shellName: "a" })).metadata.exitCode).toBe(0);
			await expect(runner.run({ command: "pwd", toolCallId: "same-call", shellName: "b" })).rejects.toThrow(
				"This Bash call already has a different command.",
			);
			await expect(runner.run({ command: "pwd", toolCallId: "job:x:1" })).rejects.toThrow(
				"Invalid Bash call identity.",
			);
		});
	});

	describe("plugin volume mounts", () => {
		const VOLUME_TEXT = "# unfinished [markdown\nMountneedle marker.\nUnicode: café 🐒\nLast line\n";
		const VOLUME_PATH = "/.mounts/research/repo/notes.md";

		async function seed_generation(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			installationId: Id<"plugins_workspace_installations">;
			volumeId: Id<"plugins_volumes">;
			files: { path: string; text: string }[];
			opts?: { status?: "published" | "staging"; revision?: string; chunks?: boolean };
		}) {
			const { runner, volumeId, files, opts = {}, installationId } = args;

			return await runner.t.run(async (ctx) => {
				const now = Date.now();
				const tenant = { organizationId: runner.seeded.organizationId, workspaceId: runner.seeded.workspaceId };
				const generationId = await ctx.db.insert("plugins_volume_generations", {
					...tenant,
					installationId,
					volumeId,
					status: opts.status ?? "published",
					revision: opts.revision ?? "copy-1",
					fileCount: files.length,
					bytes: files.reduce((sum, file) => sum + new TextEncoder().encode(file.text).byteLength, 0),
					createdAt: now,
					lastWriteAt: now,
					publishedAt: opts.status === "staging" ? null : now,
					expiresAt: null,
					drainScheduledUntil: null,
				});
				const scope = { organizationId: tenant.organizationId, workspaceId: volumeId };
				const nodes: { nodeId: Id<"files_nodes">; assetId: Id<"files_r2_assets">; r2Key: string }[] = [];
				// This is the trusted SYSTEM materialization path. Reads use the real Bash doors below.
				for (const file of files) {
					const path = `/${generationId}${file.path}`;
					const contentType = files_guess_content_type_from_name(file.path);
					const bytes = new TextEncoder().encode(file.text);
					const assetId = await ctx.db.insert("files_r2_assets", {
						...scope,
						kind: "content",
						r2Bucket: r2.config.bucket,
						size: bytes.byteLength,
						createdBy: users_SYSTEM_AUTHOR,
						updatedAt: now,
					});
					const r2Key = `bash-volume/${assetId}`;
					await ctx.db.patch("files_r2_assets", assetId, { r2Key });
					test_r2_objects.set(r2Key, bytes);
					const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
						...scope,
						userId: users_SYSTEM_AUTHOR,
						parentId: files_ROOT_ID,
						path,
						kind: "file",
						contentType,
						assetId,
						expectsTextContent: true,
						now,
					});
					if (created._nay) throw new Error(created._nay.message);
					const nodeId = created._yay;
					await ctx.db.patch("files_nodes", nodeId, { contentByteSize: bytes.byteLength });
					if (opts.chunks !== false)
						await files_nodes_db_insert_file_content_docs(ctx, {
							...scope,
							nodeId,
							path,
							contentType,
							rootKind: "plain_text",
							textContent: file.text,
							readOnly: true,
							userId: users_SYSTEM_AUTHOR,
							now,
						});
					nodes.push({ nodeId, assetId, r2Key });
				}
				return { generationId, nodes };
			});
		}

		async function create_volume_runner(opts: { reader?: boolean; large?: boolean; chunks?: boolean } = {}) {
			const t = test_convex();
			const owner = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "mount-team", workspaceName: "home" }),
			);
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
			let seeded = owner;
			if (opts.reader) {
				const reader = await t.run((ctx) =>
					test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
				);
				expect(
					await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: owner.organizationId,
						workspaceId: owner.workspaceId,
						userIdToAdd: reader.userId,
					}),
				).toEqual({ _yay: null });
				const membership = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", owner.workspaceId).eq("userId", reader.userId).eq("active", true),
						)
						.unique(),
				);
				if (!membership) throw new Error("Expected reader membership");
				seeded = { ...owner, userId: reader.userId, membershipId: membership._id };
			}
			const runner = await create_bash_runner({ shared: { t, seeded } });
			const capabilities = ["workspace.volumes.write", "plugin.backend.invoke"] as const;
			const pluginVersionId = await t.run((ctx) =>
				ctx.db.insert("plugins_versions", {
					name: "research",
					displayName: "Research",
					version: "0.1.0",
					description: "External records",
					reviewStatus: "passed",
					reviewId: null,
					isLatest: true,
					artifactHash: `sha256:${"a".repeat(64)}`,
					sourceRepositoryUrl: "https://github.com/example/research",
					sourceOwner: "example",
					sourceRepo: "research",
					sourceCommitSha: "a".repeat(40),
					manifestR2Key: "research/manifest.json",
					backendEntrypointFile: {
						entry: "backend.js",
						moduleName: "backend",
						r2Key: "research/backend.js",
						sha256: "a".repeat(64),
						compatibilityDate: "2026-01-01",
						compatibilityFlags: [],
					},
					configuration: { description: "Mount name", defaultYaml: "mount:\n  name: research\n" },
					mounts: [{ id: "sources", description: "External records", configurationPath: ["mount", "name"] }],
					events: [],
					capabilities: [...capabilities],
					endpoints: [{ id: "refresh", path: "/refresh", serialization: "installation" }],
					pages: [],
					fileViews: [],
					outboundOrigins: [],
					uiOutboundOrigins: [],
					mcpServers: [],
					mcpServersFingerprint: "research-mcp",
					skills: [],
					files: [],
					sourceStatus: "ready",
					sourceLastError: null,
					createdBy: owner.userId,
					updatedAt: Date.now(),
					secrets: [],
					userWritableCollections: null,
				}),
			);
			const installed = await asOwner.mutation(api.plugins.install_version, {
				membershipId: owner.membershipId,
				pluginVersionId,
				acceptedCapabilities: [...capabilities],
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				acceptedMcpServersFingerprint: "research-mcp",
				acceptedSkillNames: [],
			});
			if (installed._nay) throw new Error(installed._nay.message);
			const installationId = installed._yay.installationId;
			const claim = await t.run((ctx) =>
				ctx.db
					.query("plugins_mounts")
					.withIndex("by_organization_workspace_installation", (q) =>
						q
							.eq("organizationId", owner.organizationId)
							.eq("workspaceId", owner.workspaceId)
							.eq("installationId", installationId),
					)
					.unique(),
			);
			if (!claim) throw new Error("Expected mount claim");
			const volumeId = await t.run((ctx) =>
				ctx.db.insert("plugins_volumes", {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					installationId,
					mountId: "sources",
					volumeKey: "repo",
					publishedGenerationId: null,
					createdAt: Date.now(),
					deleteRequestedAt: null,
					drainScheduledUntil: null,
				}),
			);
			const text = opts.large ? `${"Mountneedle line\n".repeat(6000)}END\n` : VOLUME_TEXT;
			const copy = await seed_generation({
				runner,
				installationId,
				volumeId,
				files: [
					{ path: "/notes.md", text },
					{ path: "/guide.md", text: "Mountneedle guide\n" },
					{ path: "/records/sample/item-1.json", text: '{"name":"Mountneedle"}\n' },
				],
				opts: { chunks: opts.chunks },
			});
			await t.run((ctx) => ctx.db.patch("plugins_volumes", volumeId, { publishedGenerationId: copy.generationId }));
			return { runner, owner, asOwner, installationId, claimId: claim._id, volumeId, ...copy, text };
		}

		async function seed_legacy_mount(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			name: string;
			synced?: boolean;
		}) {
			const { runner, name, synced = true } = args;

			const inserted = await runner.t.mutation(internal.github_mounts.upsert_mount, {
				name,
				owner: "example",
				repo: "legacy",
				ref: "main",
			});
			if (inserted._nay) throw new Error(inserted._nay.message);
			if (synced) {
				const sha = "a".repeat(40);
				await runner.t.run((ctx) => ctx.db.patch("github_mounts", inserted._yay.mountId, { lastCommitSha: sha }));
				const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					path: `/${name}/${sha}/old.md`,
					rawText: "Mountneedle legacy\n",
				});
				if (created._nay) throw new Error(created._nay.message);
			}
			return inserted._yay.mountId;
		}

		test("reads published copies through every reader and forwards the original source", async () => {
			const f = await create_volume_runner();
			for (const [command, text] of [
				[`cat ${VOLUME_PATH}`, VOLUME_TEXT],
				[`head -n 1 ${VOLUME_PATH}`, "# unfinished [markdown\n"],
				[`tail -n 1 ${VOLUME_PATH}`, "Last line\n"],
				[`sed -n '2p' ${VOLUME_PATH}`, "Mountneedle marker.\n"],
				[`grep Mountneedle ${VOLUME_PATH}`, "Mountneedle marker.\n"],
				[`wc -l ${VOLUME_PATH}`, "4"],
				[`textgrep Mountneedle ${VOLUME_PATH}`, "Mountneedle"],
				[`stat -c %s ${VOLUME_PATH}`, String(new TextEncoder().encode(VOLUME_TEXT).byteLength)],
				["cat /.mounts/research/repo/records/sample/item-1.json", '{"name":"Mountneedle"}\n'],
			] as const) {
				const result = await f.runner.run({ command });
				expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
				expect(result.stdout, command).toContain(text);
			}
			for (const command of [
				"ls /.mounts/research/repo",
				"tree /.mounts/research/repo --limit 20",
				"find /.mounts/research/repo --limit 20",
				"search --path /.mounts/research/repo Mountneedle",
				`meta get ${VOLUME_PATH}`,
			]) {
				const result = await f.runner.run({ command });
				expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
			}
			const volumeReads = [...f.runner.runQuery.mock.calls, ...f.runner.runAction.mock.calls].filter(
				([ref, args]) => args.workspaceId === f.volumeId && function_name_of(ref)?.startsWith("files_"),
			);
			expect(volumeReads.length).toBeGreaterThan(8);
			for (const [, args] of volumeReads)
				expect(args.agentSource).toEqual({
					organizationId: f.runner.ctxData.organizationId,
					workspaceId: f.runner.ctxData.workspaceId,
					userId: f.runner.ctxData.userId,
					threadId: f.runner.ctxData.threadId,
					membershipId: f.runner.ctxData.membershipId,
					membershipLifetime: f.runner.ctxData.membershipLifetime,
					run: f.runner.chatRun,
				});
			expect((await f.runner.run({ command: `resolve ${f.nodes[0].nodeId}` })).metadata.exitCode).not.toBe(0);
		});

		test.each([
			`printf changed > ${VOLUME_PATH}`,
			`printf changed >> ${VOLUME_PATH}`,
			`printf changed | tee ${VOLUME_PATH}`,
			`touch ${VOLUME_PATH}`,
			`rm ${VOLUME_PATH}`,
			`mv ${VOLUME_PATH} /tmp/moved.md`,
			`cp /tmp/new.md ${VOLUME_PATH}`,
			"mkdir /.mounts/research/repo/new-folder",
			"mkdir -p /.mounts/research/repo/records",
			`chmod 777 ${VOLUME_PATH}`,
			`ln -s ${VOLUME_PATH} /.mounts/research/repo/link`,
			"mkdir /.mounts/research/new-leaf",
			"printf changed > /.mounts/research/new-leaf",
			"rm -r /.mounts/research",
		])("refuses writes through %s", async (command) => {
			const f = await create_volume_runner();
			await f.runner.run({ command: "printf new > /tmp/new.md" });
			const result = await f.runner.run({ command });
			expect(result.metadata.exitCode, command).not.toBe(0);
			expect((await f.runner.run({ command: `cat ${VOLUME_PATH}` })).stdout).toBe(VOLUME_TEXT);
			expect(await f.runner.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		});

		test("copies data to scratch and never executes mounted code", async () => {
			const f = await create_volume_runner();
			expect((await f.runner.run({ command: `cp ${VOLUME_PATH} /tmp/notes.md && cat /tmp/notes.md` })).stdout).toBe(
				VOLUME_TEXT,
			);
			for (const command of [`bash ${VOLUME_PATH}`, `source ${VOLUME_PATH}`, `eval "$(cat ${VOLUME_PATH})"`])
				expect((await f.runner.run({ command })).metadata.exitCode).not.toBe(0);
		});

		test("reads large published text through bounded reader modes", async () => {
			const f = await create_volume_runner({ large: true });
			for (const command of [
				`cat ${VOLUME_PATH}`,
				`head -n 1 ${VOLUME_PATH}`,
				`tail -n 1 ${VOLUME_PATH}`,
				`sed -n '2p' ${VOLUME_PATH}`,
				`wc -l ${VOLUME_PATH}`,
				`grep -c Mountneedle ${VOLUME_PATH}`,
				`textgrep -c Mountneedle ${VOLUME_PATH}`,
			]) {
				const result = await f.runner.run({ command });
				expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
				expect(result.stdout.length, command).toBeGreaterThan(0);
				expect(result.stdout.length, command).toBeLessThan(20_000);
			}
		});

		test.each([
			`cat ${VOLUME_PATH}`,
			`head -n 1 ${VOLUME_PATH}`,
			`tail -n 1 ${VOLUME_PATH}`,
			`wc ${VOLUME_PATH}`,
			`sed -n '2p' ${VOLUME_PATH}`,
			`grep Mountneedle ${VOLUME_PATH}`,
			`textgrep Mountneedle ${VOLUME_PATH}`,
			`stat ${VOLUME_PATH}`,
			`meta get ${VOLUME_PATH}`,
			"ls /.mounts/research/repo",
			"tree /.mounts/research/repo",
			"find /.mounts/research/repo",
			"search --path /.mounts/research/repo Mountneedle",
		])("refuses pinned readers after installation disable: %s", async (command) => {
			const f = await create_volume_runner();
			const baseQuery = f.runner.runQuery.getMockImplementation()!;
			let disabled = false;
			f.runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await baseQuery(ref, args);
				if (!disabled && function_name_of(ref) === "plugins:list_bash_volume_mounts") {
					disabled = true;
					await f.runner.t.run((ctx) =>
						ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" }),
					);
				}
				return result;
			});
			const result = await f.runner.run({ command });
			expect(disabled).toBe(true);
			expect(result.stdout, command).not.toContain("Mountneedle");
			expect(result.stdout, command).not.toContain("notes.md");
			expect(result.metadata.exitCode, command).not.toBe(0);
		});

		test("lists mixed trees with correct root and group depths", async () => {
			const f = await create_volume_runner();
			await seed_legacy_mount({ runner: f.runner, name: "legacy" });
			expect((await f.runner.run({ command: "ls /.mounts" })).stdout).toBe("legacy\nresearch\n");
			expect((await f.runner.run({ command: "ls /.mounts/research" })).stdout).toBe("repo\n");
			const mixedListing = await f.runner.run({ command: "ls /tmp /.mounts/research --limit 1" });
			expect(mixedListing.metadata.exitCode, mixedListing.stderr).toBe(0);
			expect(mixedListing.stdout).toContain("repo");
			const rootOne = await f.runner.run({ command: "find /.mounts -maxdepth 1 --limit 20" });
			expect(rootOne.stdout).toContain("/.mounts/legacy/");
			expect(rootOne.stdout).toContain("/.mounts/research/");
			expect(rootOne.stdout).not.toContain("repo");
			const rootTwo = await f.runner.run({ command: "find /.mounts -maxdepth 2 --limit 20" });
			expect(rootTwo.stdout).toContain("/.mounts/legacy/old.md");
			expect(rootTwo.stdout).toContain("/.mounts/research/repo/");
			expect(rootTwo.stdout).not.toContain("notes.md");
			const groupOne = await f.runner.run({ command: "find /.mounts/research -maxdepth 1 --limit 20" });
			expect(groupOne.stdout).toContain("/.mounts/research/repo/");
			expect(groupOne.stdout).not.toContain("notes.md");
			// A mount reads its root, its root and children, or its whole subtree; deeper limits are refused.
			const groupTwo = await f.runner.run({ command: "find /.mounts/research -maxdepth 2 --limit 20" });
			expect(groupTwo.stdout).toContain("/.mounts/research/repo/notes.md");
			expect(groupTwo.stdout).toContain("/.mounts/research/repo/records/");
			expect(groupTwo.stdout).not.toContain("sample");
			const groupThree = await f.runner.run({ command: "find /.mounts/research -maxdepth 3 --limit 20" });
			expect(groupThree.metadata.exitCode).toBe(2);
			expect(groupThree.stderr).toContain("its direct children (-maxdepth 2), or the whole subtree");
			const folders = await f.runner.run({ command: "find /.mounts -type d --limit 20" });
			expect(folders.stdout).toContain("/.mounts/research/");
			expect(folders.stdout).toContain("/.mounts/research/repo/records/sample/");
			for (const base of ["/.mounts", "/.mounts/research"]) {
				for (const command of [
					`ls -R ${base} --limit 20`,
					`tree ${base} --limit 20`,
					`find ${base} -type f --limit 20`,
					`search --path ${base} Mountneedle`,
				]) {
					const result = await f.runner.run({ command });
					expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
					expect(result.stdout, command).toContain("notes.md");
					if (base !== "/.mounts") expect(result.stdout, command).not.toContain("legacy");
				}
			}
			expect(
				(await f.runner.run({ command: "meta search --path /.mounts/research name=Mountneedle" })).metadata.exitCode,
			).not.toBe(0);
			expect((await f.runner.run({ command: "grep -R Mountneedle /.mounts/research" })).stdout).toContain(
				"search --path /.mounts/research",
			);
			expect((await f.runner.run({ command: "textgrep -R Mountneedle /.mounts/research" })).stderr).toContain(
				"search --path /.mounts/research",
			);
		});

		test.each([false, true])("skips a whole plugin group after a later legacy claim (synced %s)", async (synced) => {
			const f = await create_volume_runner();
			await seed_legacy_mount({ runner: f.runner, name: "research", synced });
			const result = await f.runner.run({ command: `cat ${VOLUME_PATH}` });
			expect(result.stdout, "collision must hide the plugin copy").toBe("");
			expect(result.metadata.exitCode).not.toBe(0);
			for (const command of [
				"find /.mounts --limit 20",
				"tree /.mounts --limit 20",
				"search --path /.mounts Mountneedle",
			]) {
				const listed = await f.runner.run({ command });
				expect(listed.stdout).not.toContain("repo");
				expect(listed.stdout).not.toContain("notes.md");
			}
		});

		test("hides staging copies and unpublished leaves", async () => {
			const f = await create_volume_runner();
			await seed_generation({
				runner: f.runner,
				installationId: f.installationId,
				volumeId: f.volumeId,
				files: [{ path: "/staging.md", text: "Stagingneedle\n" }],
				opts: { status: "staging", revision: "copy-2" },
			});
			expect((await f.runner.run({ command: "find /.mounts --limit 20" })).stdout).not.toContain("staging.md");
			expect((await f.runner.run({ command: "search --path /.mounts Stagingneedle" })).stdout).toContain(
				"No content matches",
			);
			await f.runner.t.run((ctx) => ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: null }));
			expect((await f.runner.run({ command: "ls /.mounts/research" })).metadata.exitCode).not.toBe(0);
		});

		test.each(["find", "ls -R", "tree", "search"] as const)(
			"keeps %s cursors scoped to a root or group and rejects changed copies",
			async (command) => {
				const f = await create_volume_runner();
				const build = (base: string) =>
					command === "search" ? `search --path ${base} Mountneedle --limit 1` : `${command} ${base} --limit 1`;
				const rootPage = await f.runner.run({ command: build("/.mounts") });
				const rootNext = rootPage.stdout.split("Next page: ")[1]?.split("\n")[0].trim();
				expect(rootNext, rootPage.stdout).toBeTruthy();
				const wrongGroup = await f.runner.run({ command: rootNext!.replace("/.mounts", "/.mounts/research") });
				expect(wrongGroup.metadata.exitCode).not.toBe(0);
				expect(wrongGroup.stderr).toContain("does not belong");
				const groupPage = await f.runner.run({ command: build("/.mounts/research") });
				const groupNext = groupPage.stdout.split("Next page: ")[1]?.split("\n")[0].trim();
				expect(groupNext, groupPage.stdout).toBeTruthy();
				expect((await f.runner.run({ command: groupNext! })).metadata.exitCode).toBe(0);
				const next = await seed_generation({
					runner: f.runner,
					installationId: f.installationId,
					volumeId: f.volumeId,
					files: [{ path: "/notes.md", text: "Mountneedle replacement\n" }],
					opts: { revision: "copy-2" },
				});
				await f.runner.t.run((ctx) =>
					ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: next.generationId }),
				);
				const changed = await f.runner.run({ command: groupNext! });
				expect(changed.metadata.exitCode).not.toBe(0);
				expect(changed.stderr).toContain("listing changed");
			},
		);

		test("rejects renamed root cursors and climbs cwd after rename or deletion", async () => {
			const f = await create_volume_runner();
			const page = await f.runner.run({ command: "find /.mounts --limit 1" });
			const next = page.stdout.split("Next page: ")[1]?.split("\n")[0].trim();
			expect(next).toBeTruthy();
			expect((await f.runner.run({ command: "cd /.mounts/research/repo/records/sample" })).metadata.exitCode).toBe(0);
			await f.runner.t.run((ctx) => ctx.db.patch("plugins_mounts", f.claimId, { name: "renamed" }));
			expect((await f.runner.run({ command: "pwd" })).stdout).toBe("/.mounts\n");
			expect((await f.runner.run({ command: next! })).stderr).toContain("listing changed");
			expect((await f.runner.run({ command: "cd /.mounts/renamed/repo/records/sample" })).metadata.exitCode).toBe(0);
			await f.runner.t.run((ctx) => ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now() }));
			expect((await f.runner.run({ command: "pwd" })).stdout).toBe("/\n");
		});

		test.each(["disabled", "uninstalled", "purging", "deleting", "foreign workspace"] as const)(
			"refuses a volume after %s",
			async (state) => {
				const f = await create_volume_runner();
				expect((await f.runner.run({ command: `cat ${VOLUME_PATH}` })).stdout).toBe(VOLUME_TEXT);
				await f.runner.t.run(async (ctx) => {
					if (state === "disabled")
						await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
					else if (state === "uninstalled") await ctx.db.delete("plugins_workspace_installations", f.installationId);
					else if (state === "purging")
						await ctx.db.patch("organizations_workspaces", f.owner.workspaceId, {
							pluginDataPurgeStartedAt: Date.now(),
						});
					else if (state === "deleting")
						await ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now() });
					else {
						const other = await test_mocks_fill_db_with.membership(ctx, {
							organizationName: "other-team",
							workspaceName: "home",
						});
						await ctx.db.patch("plugins_volumes", f.volumeId, { workspaceId: other.workspaceId });
					}
				});
				if (state === "purging") {
					await expect(f.runner.run({ command: `cat ${VOLUME_PATH}` })).rejects.toThrow("Unauthorized");
					return;
				}
				const refused = await f.runner.run({ command: `cat ${VOLUME_PATH}` });
				expect(refused.stdout).toBe("");
				expect(refused.metadata.exitCode).not.toBe(0);
			},
		);

		test.each(["disabled", "uninstalled", "purging", "left and rejoined", "role loss"] as const)(
			"rechecks access after paused R2 reads (%s)",
			async (state) => {
				const f = await create_volume_runner({ reader: true, large: true, chunks: false });
				let arrive = () => {};
				let resume = () => {};
				const started = new Promise<void>((resolve) => {
					arrive = resolve;
				});
				const paused = new Promise<void>((resolve) => {
					resume = resolve;
				});
				const baseFetch = vi.mocked(fetch).getMockImplementation()!;
				const baseAction = f.runner.runAction.getMockImplementation()!;
				const readResults: unknown[] = [];
				f.runner.runAction.mockImplementation(async (ref, args) => {
					const result = await baseAction(ref, args);
					if (function_name_of(ref) === "files_nodes_content:read_file_line_range") readResults.push(result);
					return result;
				});
				let intercepted = false;
				vi.mocked(fetch).mockImplementation(async (input, init) => {
					const response = await baseFetch(input, init);
					const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					if (!intercepted && href.endsWith(encodeURIComponent(f.nodes[0].r2Key))) {
						intercepted = true;
						arrive();
						await paused;
					}
					return response;
				});
				const reading = Promise.allSettled([f.runner.run({ command: `head -n 1 ${VOLUME_PATH}` })]);
				await started;
				if (state === "left and rejoined") {
					const asReader = f.runner.t.withIdentity({
						issuer: "https://clerk.test",
						external_id: f.runner.seeded.userId,
					});
					expect(
						await asReader.mutation(api.organizations.remove_user_from_organization, {
							organizationId: f.owner.organizationId,
							userIdToRemove: f.runner.seeded.userId,
						}),
					).toEqual({ _yay: null });
					expect(
						await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
							organizationId: f.owner.organizationId,
							workspaceId: f.owner.workspaceId,
							userIdToAdd: f.runner.seeded.userId,
						}),
					).toEqual({ _yay: null });
				} else if (state === "role loss") {
					const role = await f.asOwner.mutation(api.access_control.create_role, {
						organizationId: f.owner.organizationId,
						name: "Workspace maker",
						description: "",
						permissions: ["workspace.create"],
					});
					if (role._nay) throw new Error(role._nay.message);
					expect(
						await f.asOwner.mutation(api.access_control.set_user_role, {
							organizationId: f.owner.organizationId,
							workspaceId: f.owner.workspaceId,
							userId: f.runner.seeded.userId,
							role: role._yay.roleId,
						}),
					).toEqual({ _yay: null });
				} else
					await f.runner.t.run(async (ctx) => {
						if (state === "disabled")
							await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
						else if (state === "uninstalled") await ctx.db.delete("plugins_workspace_installations", f.installationId);
						else
							await ctx.db.patch("organizations_workspaces", f.owner.workspaceId, {
								pluginDataPurgeStartedAt: Date.now(),
							});
					});
				resume();
				const [settled] = await reading;
				expect(intercepted).toBe(true);
				expect(readResults, "the paused read must not release old text").toEqual([null]);
				if (state === "purging" || state === "left and rejoined" || state === "role loss") {
					expect(settled.status).toBe("rejected");
					if (settled.status === "rejected") expect(String(settled.reason)).toContain("Unauthorized");
				} else {
					expect(settled.status).toBe("fulfilled");
					if (settled.status === "fulfilled") {
						expect(settled.value.stdout).toBe("");
						expect(settled.value.metadata.exitCode).not.toBe(0);
					}
				}
			},
		);

		test("refuses cached cat text after access changes during its second size lookup", async () => {
			const f = await create_volume_runner();
			const baseQuery = f.runner.runQuery.getMockImplementation()!;
			let sizeReads = 0;
			f.runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await baseQuery(ref, args);
				if (function_name_of(ref) === "r2:get_asset_by_id" && args.assetId === f.nodes[0].assetId) {
					sizeReads += 1;
					if (sizeReads === 2)
						await f.runner.t.run((ctx) =>
							ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" }),
						);
				}
				return result;
			});
			const result = await f.runner.run({ command: `cat ${VOLUME_PATH}; cat ${VOLUME_PATH}` });
			expect(sizeReads).toBe(2);
			expect(result.stdout, "cached content must not be released after the volume becomes unreadable").toBe(
				VOLUME_TEXT,
			);
			expect(result.metadata.exitCode).not.toBe(0);
		});

		test.each(["disabled", "replacement"] as const)(
			"rechecks exact file metadata after the size lookup (%s)",
			async (state) => {
				const f = await create_volume_runner();
				let arrive = () => {};
				let resume = () => {};
				const started = new Promise<void>((resolve) => {
					arrive = resolve;
				});
				const paused = new Promise<void>((resolve) => {
					resume = resolve;
				});
				const baseQuery = f.runner.runQuery.getMockImplementation()!;
				let intercepted = false;
				f.runner.runQuery.mockImplementation(async (ref, args) => {
					const result = await baseQuery(ref, args);
					if (!intercepted && function_name_of(ref) === "r2:get_asset_by_id" && args.assetId === f.nodes[0].assetId) {
						intercepted = true;
						arrive();
						await paused;
					}
					return result;
				});
				const reading = f.runner.run({ command: `stat -c %s ${VOLUME_PATH}` });
				await started;
				await f.runner.t.run(async (ctx) => {
					if (state === "disabled")
						await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
					else {
						const old = await ctx.db.get("files_nodes", f.nodes[0].nodeId);
						if (!old) throw new Error("Expected the original node");
						const { _id, _creationTime, ...fields } = old;
						await ctx.db.delete("files_nodes", _id);
						await ctx.db.insert("files_nodes", fields);
					}
				});
				resume();
				const result = await reading;
				expect(intercepted).toBe(true);
				expect(result.stdout, "the final target check must withhold stale metadata").toBe("");
				expect(result.metadata.exitCode).not.toBe(0);
			},
		);

		test("reads the pinned retired copy during publication until its files are removed", async () => {
			const f = await create_volume_runner({ large: true, chunks: false });
			const next = await seed_generation({
				runner: f.runner,
				installationId: f.installationId,
				volumeId: f.volumeId,
				files: [{ path: "/notes.md", text: "Replacement text\n" }],
				opts: { revision: "copy-2" },
			});
			const baseFetch = vi.mocked(fetch).getMockImplementation()!;
			let changed = false;
			vi.mocked(fetch).mockImplementation(async (input, init) => {
				const response = await baseFetch(input, init);
				if (!changed) {
					changed = true;
					await f.runner.t.run(async (ctx) => {
						await ctx.db.patch("plugins_volume_generations", f.generationId, {
							status: "retired",
							expiresAt: Date.now() + 600_000,
						});
						await ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: next.generationId });
					});
				}
				return response;
			});
			const oldRead = await f.runner.run({ command: `head -n 1 ${VOLUME_PATH}` });
			expect(changed).toBe(true);
			expect(oldRead.stdout).toBe("Mountneedle line\n");
			expect(oldRead.metadata.exitCode).toBe(0);
			expect((await f.runner.run({ command: `cat ${VOLUME_PATH}` })).stdout).toBe("Replacement text\n");
			await f.runner.t.run((ctx) => ctx.db.delete("files_nodes", f.nodes[0].nodeId));
			const oldTarget = await f.runner.t.action(internal.files_nodes_content.read_file_line_range, {
				agentSource: {
					organizationId: f.runner.ctxData.organizationId,
					workspaceId: f.runner.ctxData.workspaceId,
					userId: f.runner.ctxData.userId,
					threadId: f.runner.threadId,
					membershipId: f.runner.ctxData.membershipId,
					membershipLifetime: f.runner.ctxData.membershipLifetime,
				},
				organizationId: f.owner.organizationId,
				workspaceId: f.volumeId,
				userId: f.runner.seeded.userId,
				path: `/${f.generationId}/notes.md`,
				startLine: 1,
				maxLines: 1,
			});
			expect(oldTarget).toBeNull();
		});

		test("keeps published volume mounts inside background jobs", async () => {
			const f = await create_volume_runner();
			expect((await f.runner.run({ command: `{ cat ${VOLUME_PATH}; } &` })).metadata.exitCode).toBe(0);
			const row = await job_row(f.runner, 1);
			await bash_run_job(f.runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
			const finished = await job_row(f.runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(VOLUME_TEXT);
		});
	});

	describe("github mounts (Phase F7)", () => {
		// README content is markdown-hostile on purpose and small enough to read inline from the
		// committed plain-text chunks (no R2 round-trip), matching how the sync materializes external mount content.
		const README_TEXT = "# experiment--t3-chat\n\nMounted repo readme.\nZorptelemetry marker line.\n";
		const GUIDE_TEXT = "guide alpha\nguide beta\n";
		const MOUNT_COMMIT_SHA = "a".repeat(40);

		// Seed reserved-scope (`GLOBAL`/`GITHUB`) plain-text nodes via the real Phase D path, under the
		// commit-keyed root a finished sync would produce. Bash only mounts sources whose
		// `lastCommitSha` is set, so the source row is part of the fixture.
		async function seed_github_mount(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			name: string;
			files: { path: string; rawText: string }[];
		}) {
			const { runner, name, files } = args;

			const inserted = (await runner.t.mutation(internal.github_mounts.upsert_mount, {
				name,
				owner: "raythurnvoid",
				repo: "experiment--t3-chat",
				ref: "main",
			})) as { _yay?: { mountId: Id<"github_mounts"> }; _nay?: { message: string } };
			if (!inserted._yay) {
				throw new Error(`Failed to seed github mount ${name}: ${inserted._nay?.message}`);
			}
			const mountId = inserted._yay.mountId;
			await runner.t.run((ctx) => ctx.db.patch("github_mounts", mountId, { lastCommitSha: MOUNT_COMMIT_SHA }));
			for (const file of files) {
				const created = (await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					path: `/${name}/${MOUNT_COMMIT_SHA}${file.path}`,
					rawText: file.rawText,
				})) as { _yay?: unknown; _nay?: { message: string } };
				if (!created._yay) {
					throw new Error(`Failed to seed mount file /${name}${file.path}: ${created._nay?.message}`);
				}
			}
		}

		test("lists reserved top-level mount folders at the synthetic /.mounts root", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });
			await seed_github_mount({ runner, name: "examples", files: [{ path: "/hello.md", rawText: "hello\n" }] });

			const result = await runner.run({ command: "ls /.mounts" });

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("t3-chat");
			expect(result.stdout).toContain("examples");
		});

		test("lists and reads files inside a mount byte-identically", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({
				runner,
				name: "t3-chat",
				files: [
					{ path: "/README.md", rawText: README_TEXT },
					{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
				],
			});

			const listing = await runner.run({ command: "ls /.mounts/t3-chat" });
			expect(listing.metadata.exitCode).toBe(0);
			expect(listing.stdout).toContain("README.md");
			expect(listing.stdout).toContain("docs");

			runner.runQuery.mockClear();
			const readme = await runner.run({ command: "cat /.mounts/t3-chat/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(README_TEXT);

			const guide = await runner.run({ command: "cat /.mounts/t3-chat/docs/guide.md" });
			expect(guide.metadata.exitCode).toBe(0);
			expect(guide.stdout).toBe(GUIDE_TEXT);
			expect(
				runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_pending_updates:get_by_file_node"),
			).toBe(false);
		});

		test("rejects mount glob patterns without shell-expanding reserved db files", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const result = await runner.run({ command: "ls /.mounts/t3-chat/*.md" });

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("app file glob patterns are not supported");
			expect(result.stderr).toContain("Try: find /.mounts/t3-chat -type f --extension md --limit 20");
		});

		test("reports mount folders as directories for readers", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }] });

			for (const command of [
				"cat /.mounts/t3-chat/docs",
				"head /.mounts/t3-chat/docs",
				"sed -n '1p' /.mounts/t3-chat/docs",
				"wc /.mounts/t3-chat/docs",
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("Is a directory");
			}
		});

		test("cd into a mount persists across invocations", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }] });

			const moved = await runner.run({ command: "cd /.mounts/t3-chat/docs" });
			expect(moved.metadata.exitCode).toBe(0);

			const here = await runner.run({ command: "pwd" });
			expect(here.metadata.exitCode).toBe(0);
			expect(here.stdout).toBe("/.mounts/t3-chat/docs\n");
		});

		test("grep and search find content scoped to a mount", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const grepped = await runner.run({ command: "grep Zorptelemetry /.mounts/t3-chat/README.md" });
			expect(grepped.metadata.exitCode).toBe(0);
			expect(grepped.stdout).toContain("Zorptelemetry marker line.");

			const searched = await runner.run({ command: "search --path /.mounts/t3-chat Zorptelemetry" });
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("README.md");
		});

		test("find --prefix resolves relative to mount cwd and returns zero matches for absent prefixes", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({
				runner,
				name: "t3-chat",
				files: [
					{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
					{ path: "/docs/notes.md", rawText: "notes\n" },
					{ path: "/docs-archive/leak.md", rawText: "leak\n" },
				],
			});

			const fromMount = await runner.run({ command: "cd /.mounts/t3-chat && find --prefix docs --limit 20 -type f" });
			expect(fromMount.metadata.exitCode).toBe(0);
			expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/guide.md");
			expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/notes.md");
			expect(fromMount.stdout).not.toContain("/.mounts/t3-chat/docs-archive/leak.md");

			const fromDocs = await runner.run({ command: "cd /.mounts/t3-chat/docs && find --prefix . --limit 1" });
			expect(fromDocs.metadata.exitCode).toBe(0);
			expect(fromDocs.stdout).toContain("/.mounts/t3-chat/docs/");

			const paged = await runner.run({ command: "cd /.mounts/t3-chat && find --prefix docs --limit 1" });
			expect(paged.metadata.exitCode).toBe(0);
			expect(paged.stdout).toMatch(/Next page: find --prefix \/.mounts\/t3-chat\/docs --limit 1 --cursor \S+/u);

			const missing = await runner.run({ command: "find --prefix /.mounts/nope --limit 20" });
			expect(missing.metadata.exitCode).toBe(0);
			expect(missing.stdout).toContain("0 matches.");
		});

		test("keeps mount content isolated from the tenant app file tree", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			// The default app file tree has no Zorptelemetry marker, so an app-scope search misses it:
			// the reserved mount scope is reachable only through the /.mounts prefix.
			const workspaceSearch = await runner.run({ command: "search Zorptelemetry" });
			expect(workspaceSearch.metadata.exitCode).toBe(0);
			expect(workspaceSearch.stdout).not.toContain("README.md");

			// The runner starts in the app file tree root; listing it shows app folders, never mounts.
			const workspaceRoot = await runner.run({ command: "ls" });
			expect(workspaceRoot.metadata.exitCode).toBe(0);
			expect(workspaceRoot.stdout).toContain("docs");
			expect(workspaceRoot.stdout).not.toContain("t3-chat");

			// The stored reserved path (without the /.mounts prefix) is not addressable from the shell.
			const bare = await runner.run({ command: "cat /t3-chat/README.md" });
			expect(bare.metadata.exitCode).not.toBe(0);
		});

		test("rejects every write into a read-only mount and leaves it intact", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const writes = [
				"touch /.mounts/t3-chat/new.txt",
				"rm /.mounts/t3-chat/README.md",
				"mv /.mounts/t3-chat/README.md /.mounts/t3-chat/renamed.md",
				"echo hi | tee /.mounts/t3-chat/new.txt",
				"cp /.mounts/t3-chat/README.md /.mounts/t3-chat/copy.md",
			];
			for (const command of writes) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("is a read-only mount of an external source");
			}

			// The mount file is still present and unchanged after all rejected writes.
			const readme = await runner.run({ command: "cat /.mounts/t3-chat/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(README_TEXT);
		});

		test("allows copying a mount file out to /tmp scratch", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const copied = await runner.run({
				command: "cp /.mounts/t3-chat/README.md /tmp/readme.md && cat /tmp/readme.md",
			});
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toBe(README_TEXT);
		});

		test("refuses to execute a mount file through bash", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/script.sh", rawText: "echo pwned\n" }] });

			for (const command of ["bash /.mounts/t3-chat/script.sh"]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("pwned");
				expect(result.stderr).toContain("not executable through bash");
			}

			for (const command of [
				"source /.mounts/t3-chat/script.sh",
				". /.mounts/t3-chat/script.sh",
				"BONOBO=1 source /.mounts/t3-chat/script.sh",
				"2>/tmp/source.err source /.mounts/t3-chat/script.sh",
				"command source /.mounts/t3-chat/script.sh",
				"command -- source /.mounts/t3-chat/script.sh",
				"command -p source /.mounts/t3-chat/script.sh",
				"eval 'source /.mounts/t3-chat/script.sh'",
				"eval 'BONOBO=1 source /.mounts/t3-chat/script.sh'",
				"bash -c 'source /.mounts/t3-chat/script.sh'",
				"bash -c '2>/tmp/source.err source /.mounts/t3-chat/script.sh'",
				"sh -c '. /.mounts/t3-chat/script.sh'",
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("pwned");
				expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
			}
		});

		test("keeps nested command loaders from executing mount files", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({
				runner,
				name: "t3-chat",
				files: [{ path: "/script.sh", rawText: "echo mount-loaded\n" }],
			});

			for (const command of [
				"printf '%s\\n' '/.mounts/t3-chat/script.sh' | xargs source",
				"printf '%s\\n' '/.mounts/t3-chat/script.sh' | xargs .",
				'bash -c "$(cat /.mounts/t3-chat/script.sh)"',
				'sh -c "$(cat /.mounts/t3-chat/script.sh)"',
				'eval "$(cat /.mounts/t3-chat/script.sh)"',
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("loaded");
				expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
			}
		});

		test("reports missing mount targets as no such file", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const listMissing = await runner.run({ command: "ls /.mounts/nope" });
			expect(listMissing.metadata.exitCode).not.toBe(0);
			expect(listMissing.stderr).toContain("No such file");

			const catMissing = await runner.run({ command: "cat /.mounts/nope/x.md" });
			expect(catMissing.metadata.exitCode).not.toBe(0);
			expect(catMissing.stderr).toContain("No such file");
		});

		test("keeps the launching call's mounts inside a background job", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			expect(
				(await runner.run({ command: "{ ls /.mounts; cat /.mounts/t3-chat/README.md; } &" })).metadata.exitCode,
			).toBe(0);

			// The worker builds its own filesystem, so it must fetch the mount list itself. Without
			// that query `/.mounts` is empty inside the job even though the launching call saw it.
			const row = await job_row(runner, 1);
			await bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });

			const finished = await job_row(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(`t3-chat\n${README_TEXT}`);
		});
	});

	describe("run_plugin_review", () => {
		const reviewRoot = `/review-${"a".repeat(32)}`;
		const otherRoot = `/review-${"b".repeat(32)}`;
		const source = "// Reviewneedle marker\nexport const ready = true;\n";

		async function create_review_runner() {
			const runner = await create_bash_runner();
			for (const [path, rawText] of [
				[`${reviewRoot}/dist/worker.js`, source],
				[`${reviewRoot}/script.sh`, "printf 'executed-source-marker'\n"],
				[`${otherRoot}/other.js`, "Reviewneedle Otherreviewprivate\n"],
			]) {
				const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path,
					rawText,
				});
				expect(created._nay).toBeUndefined();
			}
			let cwd = "/.plugins/review";
			let scratch: bash_ReviewScratch = { fileNodes: [], fileNodesContent: [] };
			const run = async (command: string) => {
				const result = await runner.t.action(internal.bash.run_plugin_review, {
					reviewRoot,
					userId: runner.seeded.userId,
					command,
					cwd,
					scratch,
				});
				cwd = result.cwd;
				scratch = result.scratch;
				return result;
			};
			return { runner, run };
		}

		test("reads and searches only the pinned source tree with ordinary Bash commands", async () => {
			const { run } = await create_review_runner();
			const read = await run("cat dist/worker.js");
			expect(read.exitCode).toBe(0);
			expect(read.output).toContain(source.trim());
			for (const command of [
				"ls dist",
				"find .",
				"grep -n Reviewneedle dist/worker.js",
				"search Reviewneedle",
				"tree /.plugins",
				"find /.plugins",
				"search --path /.plugins Reviewneedle",
				"cd /tmp && search Reviewneedle",
				`meta search --where '{"eq":["metadata.source","plugin-source"]}'`,
				"cd / && search Reviewneedle",
			]) {
				const result = await run(command);
				expect(result.exitCode, result.output).toBe(0);
				expect(result.output).toContain("worker.js");
				expect(result.output).not.toContain("Otherreviewprivate");
				expect(result.output).not.toContain("other.js");
			}
		});

		test("has no /shells mount and no jobs, wait or kill; & runs inline", async () => {
			const { run } = await create_review_runner();
			expect((await run("ls /shells")).exitCode).not.toBe(0);
			for (const command of ["jobs", "kill 1"]) {
				const result = await run(command);
				expect(result.exitCode, result.output).toBe(127);
			}
			const inline = await run("echo inline &");
			expect(inline.exitCode, inline.output).toBe(0);
			expect(inline.output).toContain("inline");
			expect(inline.output).not.toContain("started job");
		});

		test("resolve refuses tenant and reserved IDs in plugin review", async () => {
			const { runner, run } = await create_review_runner();
			const tenantId = await get_seeded_node_id(runner, "/docs/readme.md");
			const reserved = await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: "GLOBAL",
				workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
				visibilityUserId: runner.seeded.userId,
				path: `${reviewRoot}/dist/worker.js`,
			});
			expect(reserved).not.toBeNull();
			vi.mocked(fetch).mockClear();

			for (const nodeId of [tenantId, reserved!._id]) {
				const result = await run(`resolve '${nodeId}'`);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain("unavailable in this chat's workspaces");
				expect(result.output).not.toContain("/docs/readme.md");
				expect(result.output).not.toContain("dist/worker.js");
			}
			const tenantLookup = await runner.run({ command: `resolve '${reserved!._id}'` });
			expect(tenantLookup.metadata.exitCode).toBe(1);
			expect(tenantLookup.stdout).toBe("");
			expect(tenantLookup.metadata.observedPaths).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		});

		test("keeps cwd and scratch between calls without writing a chat thread", async () => {
			const { runner, run } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("ai_chat_threads").collect());
			expect((await run("mkdir /tmp/notes && printf 'follow the backend' > /tmp/notes/plan && cd dist")).exitCode).toBe(
				0,
			);
			const next = await run("cat /tmp/notes/plan && cat worker.js");
			expect(next.exitCode).toBe(0);
			expect(next.cwd).toBe("/.plugins/review/dist");
			expect(next.output).toContain("follow the backend");
			expect(next.output).toContain(source.trim());
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_threads").collect())).toEqual(before);
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_files").collect())).toEqual([]);
		});

		test("hides review files from the main agent and blocks unrelated paths in review", async () => {
			const { runner, run } = await create_review_runner();
			expect((await runner.run({ command: "search Reviewneedle" })).stdout).not.toContain("worker.js");
			expect((await runner.run({ command: "cat /.plugins/review/dist/worker.js" })).metadata.exitCode).not.toBe(0);
			for (const path of [
				"/home/cloud-usr/w/personal/home/docs/readme.md",
				`${otherRoot}/other.js`,
				`/.plugins/review/../../${otherRoot.slice(1)}/other.js`,
				"/.plugins/other/other.js",
				"/.mounts/other/other.js",
				"/etc/passwd",
			]) {
				const result = await run(`cat ${path}`);
				expect(result.exitCode, result.output).not.toBe(0);
				expect(result.output).not.toContain("Otherreviewprivate");
				expect(result.output).not.toContain("unique-token");
			}
		});

		test("refuses source changes and mounted shell execution", async () => {
			const { run } = await create_review_runner();
			for (const command of [
				"printf changed > dist/worker.js",
				"printf changed | tee dist/worker.js",
				"rm dist/worker.js",
				"mv dist/worker.js dist/changed.js",
				"cp dist/worker.js dist/copy.js",
				"touch dist/new.js",
				"mkdir new",
				"bash script.sh",
				"source script.sh",
			]) {
				const result = await run(command);
				expect(result.exitCode, result.output).not.toBe(0);
				expect(result.output).not.toContain("executed-source-marker");
			}
			expect((await run("cat dist/worker.js")).output).toContain(source.trim());
		});

		test("bounds scratch and keeps guidance when a pipeline discards stderr", async () => {
			const { run } = await create_review_runner();
			const scratch = await run("printf '%3000s' x > /tmp/large.txt");
			expect(scratch.output).toContain("not persisted");
			expect(scratch.scratch.fileNodes).toEqual([]);
			expect((await run("cat /tmp/large.txt")).exitCode).not.toBe(0);
			const invalid = await run("cat --invalid dist/worker.js 2>/dev/null | head");
			expect(invalid.output).toContain("cat: unsupported option");
		});

		test("rejects a host request for a root outside the review namespace", async () => {
			const { runner } = await create_review_runner();
			await expect(
				runner.t.action(internal.bash.run_plugin_review, {
					reviewRoot: "/",
					userId: runner.seeded.userId,
					command: "ls",
					cwd: "/.plugins/review",
					scratch: { fileNodes: [], fileNodesContent: [] },
				}),
			).rejects.toThrow("Invalid plugin review root");
		});

		test("stages exact source and cleans only that attempt's nodes, chunks, and assets", async () => {
			const { runner } = await create_review_runner();
			const preserved = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const beforeAssets = await runner.t.run((ctx) => ctx.db.query("files_r2_assets").collect());
			const staged = await runner.t.action(internal.plugins_review.stage_sources, {
				files: [{ path: "dist/worker.js", source: "// café 🦜\r\nexport const value = 1;\r\n" }],
			});
			expect(staged._nay).toBeUndefined();
			if (!staged._yay) throw new Error("Source staging failed");
			const read = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: staged._yay.reviewRoot,
				userId: runner.seeded.userId,
				command: "cat dist/worker.js",
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(read.exitCode).toBe(0);
			expect(read.output).toContain("// café 🦜\nexport const value = 1;");
			const nodes = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const stagedNodeIds = new Set(
				nodes.filter((node) => node.path.startsWith(`${staged._yay.reviewRoot}/`)).map((node) => node._id),
			);
			const file = nodes.find((node) => node.path === `${staged._yay.reviewRoot}/dist/worker.js`);
			if (!file?.assetId) throw new Error("Staged source has no asset");
			const asset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", file.assetId!));
			expect(test_r2_objects.get(asset!.r2Key!)).toEqual(
				new TextEncoder().encode("// café 🦜\r\nexport const value = 1;\r\n"),
			);
			const stored = await runner.t.run((ctx) => ctx.db.query("files_text_chunks").collect());
			expect(stored.some((chunk) => chunk.sourceKind === "committed" && stagedNodeIds.has(chunk.fileNodeId))).toBe(
				true,
			);
			await runner.t.mutation(internal.plugins.delete_review_source_tree, { reviewRoot: staged._yay.reviewRoot });
			expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(preserved);
			expect(await runner.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(beforeAssets);
			for (const table of ["files_text_chunks", "files_plain_text_chunks"] as const) {
				const chunks = await runner.t.run((ctx) => ctx.db.query(table).collect());
				expect(chunks.some((chunk) => chunk.sourceKind === "committed" && stagedNodeIds.has(chunk.fileNodeId))).toBe(
					false,
				);
			}
		});

		test("schedules cleanup before staging so an abandoned attempt expires", async () => {
			const { runner } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			vi.useFakeTimers();
			try {
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: Array.from({ length: 30 }, (_, index) => ({ path: `dist/module-${index}.js`, source })),
				});
				expect(staged._nay).toBeUndefined();
				expect((await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).length).toBeGreaterThan(
					before.length,
				);
				await runner.t.finishAllScheduledFunctions(() => vi.runAllTimers());
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} finally {
				vi.useRealTimers();
			}
		});

		test("reads a bounded window near the end of a large minified file", async () => {
			const { runner } = await create_review_runner();
			const staged = await runner.t.action(internal.plugins_review.stage_sources, {
				files: [{ path: "dist/large.js", source: `${"x".repeat(780_000)};const payload = 'Largetailneedle';` }],
			});
			if (!staged._yay) throw new Error(staged._nay.message);
			const read = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: staged._yay.reviewRoot,
				userId: runner.seeded.userId,
				command: "grep --start-index 780000 --max-chars 2000 payload dist/large.js",
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(read.exitCode, read.output).toBe(0);
			expect(read.output).toContain("Largetailneedle");
			expect(read.output.length).toBeLessThan(3000);
		});

		test.each(["../escape.js", "/escape.js", "dist/../escape.js", "dist//escape.js"])(
			"refuses source path %s before writing anything",
			async (path) => {
				const { runner } = await create_review_runner();
				const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: [
						{ path: "dist/valid.js", source },
						{ path, source },
					],
				});
				expect(staged._nay?.message).toContain("normalized relative paths");
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			},
		);

		test("cleans partial staging when a later file cannot be created", async () => {
			const { runner } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			vi.useFakeTimers();
			try {
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: [
						{ path: "dist/worker.js", source },
						{ path: "dist/worker.js/child.js", source },
					],
				});
				expect(staged._nay).toBeDefined();
				await runner.t.finishAllScheduledFunctions(() => vi.runAllTimers());
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("plugin source mounts", () => {
		const WORKER_TEXT = "export const plugin = 'media';\nGlomtelemetry marker line.\n";
		const PLUGIN_README_TEXT = "# media plugin\n\nPlugin source readme.\n";

		// Seed a registered plugin version with a version-keyed source tree in the reserved
		// GLOBAL/PLUGINS scope, plus an enabled installation in the runner's workspace — the
		// same rows the publish + install flows produce, without the full publish pipeline.
		async function seed_plugin_mount(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			pluginName: string;
			files: { path: string; rawText: string }[];
			opts?: { installed?: boolean };
		}) {
			const { runner, pluginName, files, opts } = args;

			const now = Date.now();
			const pluginVersionId = await runner.t.run((ctx) =>
				ctx.db.insert("plugins_versions", {
					name: pluginName,
					displayName: pluginName,
					version: "0.1.0",
					description: `${pluginName} plugin`,
					reviewStatus: "passed",
					reviewId: null,
					isLatest: true,
					artifactHash: `sha256:${"a".repeat(64)}`,
					sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
					sourceOwner: "bonobo",
					sourceRepo: `${pluginName}-plugin`,
					sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
					manifestR2Key: `plugins/${pluginName}/manifest.json`,
					backendEntrypointFile: {
						entry: "dist/backend/worker.js",
						moduleName: "plugin.js",
						r2Key: `plugins/${pluginName}/backend/worker.js`,
						sha256: `sha256:${"b".repeat(64)}`,
						compatibilityDate: "2026-07-01",
						compatibilityFlags: ["nodejs_compat"],
					},
					configuration: null,
					mounts: [],
					events: [{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] }],
					pages: [],
					fileViews: [],
					capabilities: [],
					outboundOrigins: [],
					uiOutboundOrigins: [],
					mcpServers: [],
					mcpServersFingerprint: "mcp-servers-hash",
					skills: [],
					files: [],
					sourceStatus: "ready",
					sourceLastError: null,
					createdBy: runner.seeded.userId,
					updatedAt: now,
					secrets: [],
					endpoints: [],
					userWritableCollections: null,
				}),
			);
			for (const file of files) {
				const created = (await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path: `/${pluginVersionId}${file.path}`,
					rawText: file.rawText,
				})) as { _yay?: unknown; _nay?: { message: string } };
				if (!created._yay) {
					throw new Error(`Failed to seed plugin source file ${file.path}: ${created._nay?.message}`);
				}
			}
			let installationId: Id<"plugins_workspace_installations"> | null = null;
			if (opts?.installed !== false) {
				installationId = await runner.t.run(async (ctx) => {
					const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						name: pluginName,
						createdBy: runner.seeded.userId,
						createdAt: now,
						updatedAt: now,
						revokedAt: null,
					});
					await ctx.db.insert("plugins_service_account_bindings", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						pluginName,
						publisherUserId: runner.seeded.userId,
						sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
						serviceAccountId,
					});
					return await ctx.db.insert("plugins_workspace_installations", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						serviceAccountId,
						pluginVersionId,
						pluginName,
						status: "enabled",
						managementAccess: "selected",
						configurationYaml: null,
						acceptedCapabilities: [],
						capabilitiesAcceptedAt: now,
						acceptedOutboundOrigins: [],
						acceptedUiOutboundOrigins: [],
						acceptedMcpServersFingerprint: "mcp-servers-hash",
						acceptedSkillNames: [],
						outboundOriginsAcceptedAt: now,
						installedBy: runner.seeded.userId,
						updatedBy: runner.seeded.userId,
						updatedAt: now,
					});
				});
			}
			return { pluginVersionId, installationId };
		}

		test("hides /.plugins entirely when no plugin is installed", async () => {
			const runner = await create_bash_runner();
			// Published but not installed in this workspace: no existence leak.
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
				opts: {
					installed: false,
				},
			});

			const listing = await runner.run({ command: "ls /.plugins" });
			expect(listing.metadata.exitCode).not.toBe(0);
			expect(listing.stderr).toContain("No such file");

			const read = await runner.run({ command: "cat /.plugins/media/dist/backend/worker.js" });
			expect(read.metadata.exitCode).not.toBe(0);
			expect(read.stderr).toContain("No such file");

			// The fan-out commands also treat the root as nonexistent with zero installations.
			const tree = await runner.run({ command: "tree /.plugins" });
			expect(tree.metadata.exitCode).not.toBe(0);
			expect(tree.stderr).toContain("No such file");

			const found = await runner.run({ command: "find /.plugins" });
			expect(found.metadata.exitCode).not.toBe(0);
			expect(found.stderr).toContain("No such file");

			const searched = await runner.run({ command: "search --path /.plugins Glomtelemetry" });
			expect(searched.metadata.exitCode).not.toBe(0);
			expect(searched.stderr).toContain("No such file");
		});

		test("lists installed plugin names at the synthetic /.plugins root", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});
			await seed_plugin_mount({
				runner,
				pluginName: "alpha-notes",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const result = await runner.run({ command: "ls /.plugins" });

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("media");
			expect(result.stdout).toContain("alpha-notes");
		});

		test("lists and reads files inside an installed plugin byte-identically", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				],
			});

			const listing = await runner.run({ command: "ls /.plugins/media" });
			expect(listing.metadata.exitCode).toBe(0);
			expect(listing.stdout).toContain("README.md");
			expect(listing.stdout).toContain("dist");

			const readme = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(PLUGIN_README_TEXT);

			const worker = await runner.run({ command: "cat /.plugins/media/dist/backend/worker.js" });
			expect(worker.metadata.exitCode).toBe(0);
			expect(worker.stdout).toBe(WORKER_TEXT);
		});

		test("grep and search find content scoped to one plugin", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			const grepped = await runner.run({ command: "grep Glomtelemetry /.plugins/media/dist/backend/worker.js" });
			expect(grepped.metadata.exitCode).toBe(0);
			expect(grepped.stdout).toContain("Glomtelemetry marker line.");

			const searched = await runner.run({ command: "search --path /.plugins/media Glomtelemetry" });
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("worker.js");
		});

		test("fans out root-scope tree, find, and search across installed plugins in name order", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});
			await seed_plugin_mount({
				runner,
				pluginName: "alpha-notes",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const tree = await runner.run({ command: "tree /.plugins" });
			expect(tree.metadata.exitCode).toBe(0);
			expect(tree.stdout).toContain("/.plugins");
			expect(tree.stdout).toContain("|-- alpha-notes/");
			expect(tree.stdout).toContain("|-- media/");
			expect(tree.stdout).toContain("README.md");
			expect(tree.stdout).toContain("worker.js");
			expect(tree.stdout.indexOf("alpha-notes")).toBeLessThan(tree.stdout.indexOf("media"));

			const found = await runner.run({ command: "find /.plugins -type f --limit 20" });
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");

			// Depth predicates are relative to /.plugins: -maxdepth 1 keeps only plugin folders.
			const top = await runner.run({ command: "find /.plugins -maxdepth 1 --limit 20" });
			expect(top.metadata.exitCode).toBe(0);
			expect(top.stdout).toContain("/.plugins/alpha-notes/");
			expect(top.stdout).toContain("/.plugins/media/");
			expect(top.stdout).not.toContain("README.md");
			// Each plugin reads its root, its root and children, or its whole subtree.
			const twoLevels = await runner.run({ command: "find /.plugins -maxdepth 2 --limit 20" });
			expect(twoLevels.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(twoLevels.stdout).toContain("/.plugins/media/dist/");
			expect(twoLevels.stdout).not.toContain("backend");
			const childrenOnly = await runner.run({ command: "find /.plugins -mindepth 2 -maxdepth 2 --limit 20" });
			expect(childrenOnly.stdout.split("\n")).not.toContain("/.plugins/media/");
			expect(childrenOnly.stdout).toContain("/.plugins/media/dist/");
			const tooDeep = await runner.run({ command: "find /.plugins -maxdepth 3 --limit 20" });
			expect(tooDeep.metadata.exitCode).toBe(2);
			expect(tooDeep.stderr).toContain("the folder itself (-maxdepth 1), its direct children (-maxdepth 2)");

			const searched = await runner.run({ command: "search --path /.plugins Glomtelemetry" });
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("under /.plugins");
			expect(searched.stdout).toContain("/.plugins/media/dist/backend/worker.js");
		});

		test("pages the /.plugins fan-out with a composite cursor and detects listing changes", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "alpha-notes",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});
			const { installationId } = await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const firstPage = await runner.run({ command: "find /.plugins -type f --limit 1" });
			expect(firstPage.metadata.exitCode).toBe(0);
			expect(firstPage.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(firstPage.stdout).not.toContain("/.plugins/media/README.md");
			const continuation = firstPage.stdout.match(/Next page: (find .+)/)?.[1];
			expect(continuation).toBeTruthy();

			// The composite cursor resumes into the next plugin in name order.
			const secondPage = await runner.run({ command: String(continuation) });
			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("/.plugins/media/README.md");

			// Uninstalling between pages invalidates the pinned listing snapshot.
			const restartPage = await runner.run({ command: "find /.plugins -type f --limit 1" });
			const staleContinuation = restartPage.stdout.match(/Next page: (find .+)/)?.[1];
			expect(staleContinuation).toBeTruthy();
			await runner.t.run(async (ctx) => {
				if (installationId == null) {
					throw new Error("Expected seeded installation");
				}
				await ctx.db.delete("plugins_workspace_installations", installationId);
			});
			const changed = await runner.run({ command: String(staleContinuation) });
			expect(changed.metadata.exitCode).not.toBe(0);
			expect(changed.stderr).toContain("listing changed");
		});

		test("keeps guidance for root-scope --prefix and meta search", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			const prefixed = await runner.run({ command: "find --prefix /.plugins --limit 5" });
			expect(prefixed.metadata.exitCode).not.toBe(0);
			expect(prefixed.stderr).toContain("--prefix cannot scan the /.plugins root");

			const metaSearched = await runner.run({
				command: `meta search --path /.plugins --where '{"exists":"frontmatter.cc"}'`,
			});
			expect(metaSearched.metadata.exitCode).not.toBe(0);
			expect(metaSearched.stderr).toContain("choose a single plugin to search");
		});

		test("scoped tree and find work inside one plugin", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				],
			});

			const tree = await runner.run({ command: "tree /.plugins/media" });
			expect(tree.metadata.exitCode).toBe(0);
			expect(tree.stdout).toContain("README.md");
			expect(tree.stdout).toContain("worker.js");

			const found = await runner.run({ command: "find /.plugins/media -type f --limit 20" });
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toContain("/.plugins/media/README.md");
			expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");

			// Name search reads the plugin tree's saved ancestor fields.
			const byName = await runner.run({ command: "find /.plugins/media -name worker" });
			expect(byName.stdout).toBe("/.plugins/media/dist/backend/worker.js\n");
			// App files refuse these two; one plugin keeps its path word scan.
			const byPath = await runner.run({ command: "find /.plugins/media --path-query backend" });
			expect(byPath.stdout).toBe("/.plugins/media/dist/backend/\n/.plugins/media/dist/backend/worker.js\n");
			const children = await runner.run({ command: "find /.plugins/media/dist -maxdepth 1 -name backend" });
			expect(children.stdout).toBe("/.plugins/media/dist/backend/\n");
		});

		test("cd into a plugin mount persists across invocations", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			const moved = await runner.run({ command: "cd /.plugins/media/dist" });
			expect(moved.metadata.exitCode).toBe(0);

			const here = await runner.run({ command: "pwd" });
			expect(here.metadata.exitCode).toBe(0);
			expect(here.stdout).toBe("/.plugins/media/dist\n");
		});

		test("rejects every write into a plugin mount and leaves it intact", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const writes = [
				"touch /.plugins/media/new.txt",
				"rm /.plugins/media/README.md",
				"mv /.plugins/media/README.md /.plugins/media/renamed.md",
				"echo hi | tee /.plugins/media/new.txt",
				"cp /.plugins/media/README.md /.plugins/media/copy.md",
			];
			for (const command of writes) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("read-only mount of installed plugin sources");
			}

			const readme = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(PLUGIN_README_TEXT);
		});

		test("allows copying a plugin file out to /tmp scratch", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const copied = await runner.run({ command: "cp /.plugins/media/README.md /tmp/readme.md && cat /tmp/readme.md" });
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toBe(PLUGIN_README_TEXT);
		});

		test("refuses to execute plugin source through bash and source", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/script.sh", rawText: "echo pwned\n" }],
			});

			const executed = await runner.run({ command: "bash /.plugins/media/script.sh" });
			expect(executed.metadata.exitCode).not.toBe(0);
			expect(executed.stdout).not.toContain("pwned");
			expect(executed.stderr).toContain("not executable through bash");

			const sourced = await runner.run({ command: "source /.plugins/media/script.sh" });
			expect(sourced.metadata.exitCode).not.toBe(0);
			expect(sourced.stdout).not.toContain("pwned");
			expect(sourced.stderr).toContain("cannot load app files or agent-only external mounts");
		});

		test("reports not-installed plugin names as plain missing paths", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const listMissing = await runner.run({ command: "ls /.plugins/nope" });
			expect(listMissing.metadata.exitCode).not.toBe(0);
			expect(listMissing.stderr).toContain("No such file");

			const catMissing = await runner.run({ command: "cat /.plugins/nope/x.md" });
			expect(catMissing.metadata.exitCode).not.toBe(0);
			expect(catMissing.stderr).toContain("No such file");
		});

		test("keeps plugin source isolated from the tenant app tree", async () => {
			const runner = await create_bash_runner();
			const { pluginVersionId } = await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			// App-scope search never reaches the reserved plugin scope.
			const workspaceSearch = await runner.run({ command: "search Glomtelemetry" });
			expect(workspaceSearch.metadata.exitCode).toBe(0);
			expect(workspaceSearch.stdout).not.toContain("worker.js");

			// The stored version-keyed path is not addressable outside the /.plugins prefix.
			const bare = await runner.run({ command: `cat /${pluginVersionId}/dist/backend/worker.js` });
			expect(bare.metadata.exitCode).not.toBe(0);
		});

		test("drops the mount when the installation is removed", async () => {
			const runner = await create_bash_runner();
			const { installationId } = await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const visible = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(visible.metadata.exitCode).toBe(0);

			await runner.t.run(async (ctx) => {
				if (installationId == null) {
					throw new Error("Expected seeded installation");
				}
				await ctx.db.delete("plugins_workspace_installations", installationId);
			});

			// Mounts are derived per command run, so the next call already reflects the uninstall.
			const gone = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(gone.metadata.exitCode).not.toBe(0);
			expect(gone.stderr).toContain("No such file");
		});

		test("keeps the launching call's plugin mounts inside a background job", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			expect(
				(await runner.run({ command: "{ ls /.plugins; cat /.plugins/media/README.md; } &" })).metadata.exitCode,
			).toBe(0);

			// The worker builds its own filesystem, so it must fetch the installed plugins itself.
			// Without that query `/.plugins` is empty inside the job.
			const row = await job_row(runner, 1);
			await bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });

			const finished = await job_row(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(`media\n${PLUGIN_README_TEXT}`);
		});
	});
});
