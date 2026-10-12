// The find, /tmp, search, grep, tree and stat tests are in bash.search.test.ts, and the shells and mount
// tests are in bash.mounts.test.ts, so the three files can run at the same time.
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { bash_DbFilesFs, bash_READ_INLINE_MAX_BYTES } from "./bash-utils.ts";
import {
	test_db_files_mount,
	function_name_of,
	readme_seed_content,
	default_organization_files,
	create_bash_runner,
	get_shell,
	get_seeded_node,
	get_seeded_node_id,
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
});
