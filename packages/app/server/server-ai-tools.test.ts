import { test_mocks_hardcoded } from "../convex/setup.test.ts";
import { R2 } from "@convex-dev/r2";
import { asSchema } from "ai";
import { getFunctionName } from "convex/server";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { files_READ_RANGE_MAX_LINES } from "../convex/files_nodes.ts";

const exa_test = vi.hoisted(() => ({
	searchMock: vi.fn(),
	lastApiKey: undefined as string | undefined,
}));

vi.mock("exa-js", () => ({
	default: class MockExa {
		constructor(apiKey?: string) {
			exa_test.lastApiKey = apiKey;
		}

		search = exa_test.searchMock;
	},
	ExaError: class ExaError extends Error {
		override name = "ExaError";
	},
}));
import {
	ai_chat_tool_create_bash,
	ai_chat_tool_create_edit_file,
	ai_chat_tool_create_set_file_metadata,
	ai_chat_tool_create_web_search,
	ai_chat_tool_create_execute_code,
	ai_chat_tool_create_browser_run,
	ai_chat_tool_create_file_stored,
	ai_chat_tool_create_browser_reload,
	ai_chat_tool_create_browser_close,
	replace_once_or_all,
} from "./server-ai-tools.ts";
import { has_defined_property } from "../shared/shared-utils.ts";
import type { ai_chat_context_Context } from "./ai-chat-context.ts";
import { ai_chat_file_result, ai_chat_file_result_schema } from "../shared/ai-chat-files.ts";
import type { ai_chat_Observation } from "./ai-chat-file-tools.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";

type server_ai_tools_test_user_identity = NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;

const server_ai_tools_test_user_id = test_mocks_hardcoded.user.user_1.id as Id<"users">;
const server_ai_tools_test_thread_id = "thread_1" as Id<"ai_chat_threads">;

const server_ai_tools_test_ctx_data = {
	organizationId: test_mocks_hardcoded.organization_id.organization_1 as Id<"organizations">,
	workspaceId: test_mocks_hardcoded.workspace_id.workspace_1 as Id<"organizations_workspaces">,
	organizationName: "personal",
	workspaceName: "home",
	userId: server_ai_tools_test_user_id,
	membershipId: "membership-1" as Id<"organizations_workspaces_users">,
	canWriteFiles: true,
	getThreadId: () => server_ai_tools_test_thread_id,
} as const;
const server_ai_tools_test_db_files_mount = "/home/cloud-usr/w/personal/home";

const server_ai_tools_test_user_identity_default = {
	issuer: "https://clerk.test",
	subject: "subject-user-1",
	external_id: "user_1",
	name: "Test User",
} as unknown as server_ai_tools_test_user_identity;

const makeCtx = (
	runQueryImpl: (ref: any, args: any) => Promise<any>,
	args?: {
		runMutationImpl?: (ref: any, args: any) => Promise<any>;
		runActionImpl?: (ref: any, args: any) => Promise<any>;
		userIdentity?: server_ai_tools_test_user_identity;
	},
): {
	ctx: ActionCtx;
	runQuery: ReturnType<typeof vi.fn>;
	runMutation: ReturnType<typeof vi.fn>;
	runAction: ReturnType<typeof vi.fn>;
	getUserIdentity: ReturnType<typeof vi.fn>;
} => {
	const runQuery = vi.fn(runQueryImpl);
	const runMutation = vi.fn(args?.runMutationImpl ?? (async () => null));
	const runAction = vi.fn(args?.runActionImpl ?? runQueryImpl);
	const getUserIdentity = vi.fn(async () => args?.userIdentity ?? server_ai_tools_test_user_identity_default);
	const ctx = {
		runQuery,
		runMutation,
		runAction,
		auth: {
			getUserIdentity,
		},
	} as unknown as ActionCtx;
	return { ctx, runQuery, runMutation, runAction, getUserIdentity };
};

function isNotAsyncIterable<T>(value: T | AsyncIterable<T>): value is T {
	return !Symbol.asyncIterator || !(Symbol.asyncIterator in Object(value));
}

describe("ai_chat_tool_create_bash", () => {
	test("describes every app-file write as a pending proposal", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		// A file with collaboration off gets a proposal too, so the description must not promise
		// a direct save anywhere.
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("create pending proposals the user reviews in Files"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.not.stringContaining("saves immediately"),
			}),
		);
		// Stale work stays available while the next agent write prepares it.
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("your pending change becomes stale"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Your next edit or shell write automatically prepares the proposal before reading fresh text.",
				),
			}),
		);
	});

	test("forwards execution to the bash action after thread resolution", async () => {
		const { ctx, runAction } = makeCtx(async () => null, {
			runActionImpl: async () => ({
				title: `exit 0 · ${server_ai_tools_test_db_files_mount}`,
				output: "$ pwd",
				stdout: `${server_ai_tools_test_db_files_mount}\n`,
				stderr: "",
				metadata: {
					command: "pwd",
					cwd: server_ai_tools_test_db_files_mount,
					nextCwd: server_ai_tools_test_db_files_mount,
					exitCode: 0,
					stdoutTruncated: false,
					stderrTruncated: false,
					stdoutLength: server_ai_tools_test_db_files_mount.length + 1,
					stderrLength: 0,
					pathIndexTruncated: false,
					observedPaths: [],
					observedPathsTruncated: false,
				},
			}),
		});
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		const result = await tool.execute?.({ command: "pwd" }, { toolCallId: "test", messages: [] });

		if (!result) {
			throw new Error("`result` is undefined");
		}
		if (!isNotAsyncIterable(result)) {
			throw new Error("`result` is AsyncIterable but expected sync object");
		}

		expect(result.output).toBe("$ pwd");
		expect(result).not.toHaveProperty("stdout");
		expect(result).not.toHaveProperty("stderr");
		expect(result.metadata).not.toHaveProperty("observedPaths");
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				command: "pwd",
				toolCallId: "test",
				threadId: "thread_1",
				userId: server_ai_tools_test_user_id,
				organizationName: "personal",
				workspaceName: "home",
				allowDbFilesMkdir: true,
				shellName: "default",
			}),
		);
	});

	test("passes the named shell to the action and refuses a bad shell name in the schema", async () => {
		const { ctx, runAction } = makeCtx(async () => null, {
			runActionImpl: async () => ({
				title: "exit 0",
				output: "$ pwd",
				stdout: "",
				stderr: "",
				metadata: { exitCode: 0, observedPaths: [], observedPathsTruncated: false },
			}),
		});
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, { allowDbFilesMkdir: true });
		await tool.execute?.({ command: "pwd", shell: "tests" }, { toolCallId: "test", messages: [] });
		expect(runAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shellName: "tests" }));

		const schema = tool.inputSchema;
		if (!has_defined_property(schema, "parse")) {
			throw new Error("inputSchema has no parse");
		}
		expect(schema.parse({ command: "pwd" })).toEqual({ command: "pwd" });
		expect(schema.parse({ command: "pwd", shell: "a-b_1" })).toEqual({ command: "pwd", shell: "a-b_1" });
		for (const shell of ["", "Tests", "a b", "a/b", "x".repeat(33)]) {
			expect(() => schema.parse({ command: "pwd", shell })).toThrow();
		}
	});

	test("describes shells, transcripts and background jobs", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, { allowDbFilesMkdir: true });
		for (const sentence of [
			"Each new shell starts in the current workspace path",
			"cwd, variables, options and functions persist per shell",
			"a chat has at most 10 shells and none can be deleted",
			"Shell options persist per shell: set -e stays on in later calls of that shell until set +e.",
			"appends its full output to /shells/<name>/transcript",
			"Read it with tail, head -c or grep, not cat",
			"cmd & starts a background job and is the only way to start one; cmd1 && cmd2 is not a background job",
			"$! is the job number in that call only (0 in the next call",
			"continues in a new run with its variables, functions, cwd and $!",
			"Inside a background job (&), /tmp is a private copy that is dropped when the job pauses or ends",
			"A job runs one top-level statement at a time, and each run of it has an 8-minute budget and 2000 commands",
			"a minute before that the job pauses after the current statement and continues in a new run",
			"or it is cut off at 7 minutes 30 seconds and the job reports 124",
			"A job lives at most 24 hours from its &, counting the waits between its runs",
			"A top-level sleep N with a literal N of 5 seconds or more pauses the job for N seconds (at most one hour) without holding a worker",
			"a sleep with a redirection or with an assignment in front of it, ! sleep N, time sleep N, a sleep joined by && or ||",
			"a job waiting to continue after a pause prints [job N queued] and a job asked to stop prints [job N stopping]",
			"A paused job shows as queued in jobs and in Notifications, the transcript gets one entry per run of the job, and jobs -o N shows the head of the whole job's output.",
			"Using /tmp inside a job for intermediate files is fine. Never redirect a job's output to /tmp and never leave a result file there: read a job's output with jobs -o N or the shell transcript.",
			"A file a job must keep goes under the current workspace path; in Agent mode that write becomes a pending proposal. In Ask mode a job cannot write files, so its result is its output.",
			"A job runs a script and ends: no servers, no ports, no curl localhost.",
			"see the /tmp rules above for where a job's files and output go",
			"While job N runs, jobs -o N prints the output it has produced so far",
			"& binds to the last statement only",
			"to put several commands in one job write { cmd1; cmd2; } & or cmd1 && cmd2 &",
			"A job starts in the cwd at the &",
			"At most 10 of your own jobs in this workspace can be queued, running or stopping at once",
			"until a launch works or a wait that found a job live and then saw it end starts the count again",
			"A wait does not make a refused script, state, or stopping launch succeed",
			"a script over 64 KiB, a shell state over 128 KiB, and a launch from a job that is already stopping are refused every time",
			"put sequential cp or mv commands in one job: the second job's copy waits up to 60 s for the lane and then fails with exit 1",
			"jobs -o N prints the stored stdout then stderr of job N, then one final [job N exit C] line on stderr",
			"wait N waits for the named jobs",
			"wait is a shell builtin, so which wait finds nothing even though wait works",
			"wait normally returns 3 (still running)",
			"Every finished job already posts a system message and wakes you",
			"In Agent mode, set wakeOnJobFinish: true only when wait should end this turn instead of polling",
			"In that call it prints bash: waiting for job N on stderr, exits 3, and you must end the turn with a short status",
			"the job's finish starts your next run once your turn has ended",
			"a stopped job reports 143 (status stopped), a job that used its whole budget reports 124 (timed out)",
			"its result lands in the chat as a system message with its number, shell, exit code and output head, so you learn the outcome without polling",
			"Stopping the chat leaves jobs running; the Notifications panel lists every job with its Stop button",
			"fg, bg, disown and suspend are unavailable (127)",
		]) {
			expect(tool.description).toContain(sentence);
		}
		expect(tool.description).not.toContain("transfer");
		expect(tool.description).not.toContain("frees a slot");
	});

	test("offers wakeOnJobFinish only with a job wakeup, passes it to the action and ends the turn on a waiting result", async () => {
		const bash_result = (waitingForJobs?: number[]) => ({
			title: "exit 3",
			output: "$ wait",
			stdout: "",
			stderr: "",
			metadata: {
				exitCode: 3,
				observedPaths: [],
				observedPathsTruncated: false,
				...(waitingForJobs ? { waitingForJobs } : {}),
			},
		});

		// Ask mode: the field does not exist, so a model never sees it and a stored value is dropped.
		const ask = ai_chat_tool_create_bash(makeCtx(async () => null).ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: false,
			jobWakeup: null,
		});
		if (!has_defined_property(ask.inputSchema, "parse")) throw new Error("inputSchema has no parse");
		expect(ask.inputSchema.parse({ command: "wait", wakeOnJobFinish: true })).toEqual({ command: "wait" });

		const onWaiting = vi.fn();
		const { ctx, runAction } = makeCtx(async () => null, { runActionImpl: async () => bash_result() });
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
			jobWakeup: { modelId: "gpt-5.4-mini", onWaiting },
		});
		if (!has_defined_property(tool.inputSchema, "parse")) throw new Error("inputSchema has no parse");
		expect(tool.inputSchema.parse({ command: "wait", wakeOnJobFinish: true })).toEqual({
			command: "wait",
			wakeOnJobFinish: true,
		});

		await tool.execute?.({ command: "wait" }, { toolCallId: "plain", messages: [] });
		expect(runAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ wakeAgent: null }));
		expect(onWaiting).not.toHaveBeenCalled();

		await tool.execute?.({ command: "wait", wakeOnJobFinish: true }, { toolCallId: "armed", messages: [] });
		expect(runAction).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ wakeAgent: { modelId: "gpt-5.4-mini" } }),
		);
		expect(onWaiting).not.toHaveBeenCalled();

		runAction.mockImplementationOnce(async () => bash_result([1]));
		const waiting = await tool.execute?.(
			{ command: "wait", wakeOnJobFinish: true },
			{ toolCallId: "waiting", messages: [] },
		);
		expect(onWaiting).toHaveBeenCalledTimes(1);
		expect(waiting).toMatchObject({ metadata: { waitingForJobs: [1] } });
	});

	test("returns scoped rules once beside the unchanged shell output", async () => {
		const context: ai_chat_context_Context = {
			organizationId: server_ai_tools_test_ctx_data.organizationId,
			workspaceId: server_ai_tools_test_ctx_data.workspaceId,
			userId: server_ai_tools_test_user_id,
			instructions: new Map(),
			instructionBytes: 0,
		};
		const { ctx } = makeCtx(
			async (_ref, args) => {
				if (args.path !== "/docs/AGENTS.md") return null;
				return args.mode
					? { content: "Use short headings." }
					: { kind: "saved", node: { _id: "rules", kind: "file" }, path: args.path, pendingUpdate: null };
			},
			{
				runActionImpl: async () => ({
					title: "exit 0",
					output: "$ cat docs/notes.md\n\nNotes",
					stdout: "Notes",
					stderr: "",
					metadata: { exitCode: 0, observedPaths: ["/docs/notes.md"], observedPathsTruncated: false },
				}),
			},
		);
		const tool = ai_chat_tool_create_bash(
			ctx,
			{
				...server_ai_tools_test_ctx_data,
				getWorkspaceContext: () => context,
			},
			{ allowDbFilesMkdir: true },
		);
		const first = await tool.execute!({ command: "cat docs/notes.md" }, { toolCallId: "first", messages: [] });
		expect(first).toMatchObject({
			output: "$ cat docs/notes.md\n\nNotes",
			instructions: JSON.stringify({ source: "/docs/AGENTS.md", scope: "/docs/", instructions: "Use short headings." }),
		});
		expect(first).not.toHaveProperty("stdout");
		expect(first).not.toHaveProperty("stderr");
		const second = await tool.execute!({ command: "cat docs/notes.md" }, { toolCallId: "second", messages: [] });
		expect(second).not.toHaveProperty("instructions");
	});

	test("warns when a command touched more paths than its rule scan could cover", async () => {
		const context: ai_chat_context_Context = {
			organizationId: server_ai_tools_test_ctx_data.organizationId,
			workspaceId: server_ai_tools_test_ctx_data.workspaceId,
			userId: server_ai_tools_test_user_id,
			instructions: new Map(),
			instructionBytes: 0,
		};
		const { ctx } = makeCtx(async () => null, {
			runActionImpl: async () => ({
				title: "exit 0",
				output: "$ find .",
				stdout: "",
				stderr: "",
				metadata: { exitCode: 0, observedPaths: [], observedPathsTruncated: true },
			}),
		});
		const tool = ai_chat_tool_create_bash(
			ctx,
			{
				...server_ai_tools_test_ctx_data,
				getWorkspaceContext: () => context,
			},
			{ allowDbFilesMkdir: true },
		);
		const result = await tool.execute!({ command: "find ." }, { toolCallId: "many", messages: [] });
		expect(result).toHaveProperty(
			"instructions",
			"Workspace guidance is incomplete: inspect fewer app paths per Bash call.",
		);
	});

	test("describes supported app ls flags and pagination limits", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Use ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...] for app listings.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"When reporting Bash results, treat app-only flags such as --limit, --cursor, --path-query, and --extension as supported app Bash syntax",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"App-mount limitations apply only to paths under /home/cloud-usr/w/personal/home or /home/cloud-usr/w.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("/tmp has the safe Just Bash native-style scratch command surface"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("If a command touches only /tmp or stdin, use normal scratch commands"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("/tmp is durable scratch scoped to this chat thread"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"/tmp persists across Bash calls in this chat and reloads from Convex if the warm backend runtime cache is gone.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"It is not shared with new chats and is not app file storage; use app file tools for durable user-visible files.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Do not call /tmp ephemeral or temporary in a way that implies same-chat data loss.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"that is expected evidence of per-chat isolation, not a global Bash failure.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Native-style /tmp commands use Just Bash's own argument parsing and include safe text/file utilities",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("jq, base64, sha256sum"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"/tmp native commands are Just Bash browser commands, not host GNU coreutils.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"if a /tmp option fails but the command is useful, retry once with simpler native syntax.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"When retrying a /tmp command option, prefer doing related scratch work in one call when convenient",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("the Unix file command is intentionally unavailable"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If file fails or the user asks for it, do not stop after reporting that it is unavailable",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Printed Next page commands use short cursor ids without an @ prefix; run the exact printed command to continue.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If the user asks for exactly one continuation, one continuation, or one next page, run only the first printed continuation",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If the user asked for continuations from multiple commands, continue each requested command before summarizing.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"When a user names an app-root path like /docs, run it as /home/cloud-usr/w/personal/home/docs",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If a failed Bash command prints a Try: command that directly matches the user's request",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("When using bash -c or sh -c to compare /tmp and app-mount behavior"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For xargs path checks, print pathnames into xargs"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("avoid comments in command strings and process substitution"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"For multi-command inspection or eval checks, do not use set -e or hide stderr with 2>/dev/null",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("ls -l uses app metadata, not POSIX permissions"),
			}),
		);
		// The bash→app path conversion rule lives in the edit_file description (asserted
		// separately); bash only points at it so the guidance is stated once.
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"the edit_file description states how to convert a bash path to an app path",
				),
			}),
		);
	});

	test("describes read-only app paths as terminal writes while allowing copy-out", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"A read-only app file or folder can still be read, searched, downloaded, shared, and copied OUT to a writable destination.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"cp may read a read-only source, but its destination and any replaced item must be writable.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"do not retry that path with another write tool; it cannot change until the user makes it writable.",
				),
			}),
		);
	});

	test("describes the reader read cap and find depth filters", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("these readers fetch at most 10 app files per command"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("wc accepts multiple files (per-file counts plus a total)"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"find -maxdepth N and find -mindepth N filter non-search app subtree results by depth.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Content-vs-path rule: use search for text inside files, and use find only for path/name discovery.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"For recursive grep requests over an app folder, the first Bash command should be search --path <folder> <content terms>",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("do not run ls first to verify that folder"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining('Plain requests like "search for X with limit N" mean content search'),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'If the user says "search for the X file", "find the X file", "file named X", or "path/name contains X", use find.',
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"run search --path <folder> X or search X; do not substitute find --path-query.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"For search --path and meta search --path, the same app-root path rule applies: pass /home/cloud-usr/w/personal/home/folder or relative folder, never raw /folder.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Use find -name QUERY or find --path-query QUERY only for indexed app-file path/name word search",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -name is case-insensitive like -iname"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Use find <path> --extension md -type f for exact indexed extension search",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'Prefer --path-query QUERY for natural "path/name contains QUERY" requests',
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For regex path requests against app files, say regex is unsupported"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"find --prefix <prefix> --limit N [--cursor CURSOR] for a folder-boundary subtree scan",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("sibling-prefix paths such as /docs-archive are excluded from /docs"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("full-text content search across Markdown/text content"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("one distinctive word or a few plain terms"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For recursive grep, grep -R, or rg wording over an app folder"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Simple grep -R PATTERN <app-folder> is recovered through indexed full-text search",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("grep [-n] [-i] [-F] PATTERN <file>"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Normal single-file grep uses regex matching"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("-F/--fixed-strings uses literal substring matching"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For rendered plain-text chunk scans"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("regex by default; -F/--fixed-strings uses literal substring matching"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("not exact recursive regex/fixed-string grep"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Single-file textgrep has no line numbers or context flags"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("with PATH they list that directory's immediate children by update time"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("bare ls -t is still workspace-wide"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Large files are not read inline"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("cat [-n] [--] [FILE...]"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("cat unreadable-file advisories are stderr, not file content"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Uploaded source files do not alias to generated Markdown outputs."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("read the exact generated output path when the user wants converted text"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -type f and find -type d restrict app results to files or folders."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find searches app paths/names only, not file content."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("When asked for app files under a folder, include -type f"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Native find syntax can be used for /tmp paths."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'For requests like "where does X appear" or "which files mention X", run search first',
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("do not substitute find, which only searches paths/names"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("when the user asks for tree-shaped output, use tree, not ls -R"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("not regex, glob, path/name search, or exact grep"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("broad folder scopes with common terms can be heavier"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("bare search scopes to that cwd"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(`up to ${files_READ_RANGE_MAX_LINES} lines per read`),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("also -c count, -l list-if-matched, -v invert, and -A/-B/-C N context"),
			}),
		);
	});
});

test("edit tool describes preserving nested app path suffixes", () => {
	const { ctx } = makeCtx(async () => null);
	const editTool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);

	expect(editTool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining(
				"Preserve the full remaining suffix after that prefix; /home/cloud-usr/w/personal/home/folder/README.md becomes /folder/README.md, never /README.md.",
			),
		}),
	);
});

test("edit tool describes every edit as a pending update", () => {
	const { ctx } = makeCtx(async () => null);
	const editTool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);

	expect(editTool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining("This tool saves a pending update for human review."),
		}),
	);
	expect(editTool).toEqual(
		expect.objectContaining({
			description: expect.not.stringContaining("saves the edit immediately"),
		}),
	);
});

test("edit_file tool treats an invalid pending update id as absent", async () => {
	const { ctx, runQuery, runAction } = makeCtx(async () => null, {
		runActionImpl: async () => null,
	});
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);

	await expect(
		tool.execute?.(
			{
				path: "/docs/hello.md",
				oldString: "world",
				newString: "team",
				replaceAll: false,
				pendingUpdateId: "1",
			},
			{ toolCallId: "test", messages: [] },
		),
	).rejects.toThrow("File not found");

	expect(runAction).not.toHaveBeenCalled();
	expect(runQuery).toHaveBeenNthCalledWith(1, expect.anything(), { pendingUpdateId: "1" });
});

test("edit_file tool surfaces the upsert rejection when the file is archived after the read", async () => {
	const nodeId = "p456";
	const currentContent = {
		target: { kind: "saved", id: nodeId },
		content: "Hello world",
		pendingUpdateId: "pending456",
	};

	let runActionCallCount = 0;
	const { ctx, runQuery, runAction } = makeCtx(
		async () => ({
			kind: "saved",
			node: { _id: nodeId, kind: "file", assetId: "asset_edit", textKind: "plain_text" },
			path: "/docs/hello.md",
			pendingUpdate: null,
		}),
		{
			// The upsert flow stages through internal mutations first: batch create, then text input.
			runMutationImpl: async () => ({ _yay: { operationBatchId: "batch456", expiresAt: Date.now() + 60_000 } }),
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return { _yay: { pendingUpdate: null } };
				}
				if (runActionCallCount === 2) {
					return currentContent;
				}
				// The node was archived (or deleted) between the read and the upsert.
				return { _nay: { message: "Not found" } };
			},
		},
	);
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	await expect(
		tool.execute?.(
			{ path: "/docs/hello.md", oldString: "world", newString: "team", replaceAll: false },
			{ toolCallId: "test", messages: [] },
		),
	).rejects.toThrow("the proposal was not recorded: Not found");

	// The tool stops at the failed upsert: no success payload, no follow-up pending update doc read.
	expect(runAction).toHaveBeenCalledTimes(3);
	expect(runQuery).toHaveBeenCalledTimes(1);
});

test("edit_file tool stores pending unstaged branch updates from the agent", async () => {
	const nodeId = "p456";
	const pendingUpdateId = "pending456";
	const pendingUpdateBaseStateId = "base456";
	const currentContent = {
		target: { kind: "saved", id: nodeId },
		content: "Hello world",
		pendingUpdateId,
		pendingUpdateBaseStateId,
	};

	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) =>
			args.path
				? {
						kind: "saved",
						node: { _id: nodeId, kind: "file", assetId: "asset_edit", textKind: "plain_text" },
						path: args.path,
						pendingUpdate: null,
					}
				: { _id: pendingUpdateId },
		{
			// The upsert flow stages through internal mutations: batch create, then text input.
			runMutationImpl: async () => ({ _yay: { operationBatchId: "batch456", expiresAt: Date.now() + 60_000 } }),
			runActionImpl: async (_ref, args) => (args.path ? currentContent : { _yay: { pendingUpdate: null } }),
		},
	);
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/docs/hello.md",
			oldString: "world",
			newString: "team",
			replaceAll: false,
		},
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runAction).toHaveBeenCalledTimes(3);
	const [, firstQueryArgs] = runAction.mock.calls[1]!;
	expect(firstQueryArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/hello.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});
	// The modified text is staged as the one bounded text input; the finishing action then
	// carries only ids.
	const [, stagedTextArgs] = runMutation.mock.calls[1]!;
	expect(stagedTextArgs).toMatchObject({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		operationBatchId: "batch456",
		role: "unstaged",
		text: "Hello team",
	});
	const [, pendingArgs] = runAction.mock.calls[2]!;
	expect(pendingArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		target: { kind: "saved", id: nodeId },
		pendingUpdateId,
		operationBatchId: "batch456",
		expectedBaseStateId: pendingUpdateBaseStateId,
		threadId: server_ai_tools_test_thread_id,
	});

	expect(result.metadata.target).toEqual({ kind: "saved", id: nodeId });
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.matches).toBe(1);
	expect(result.metadata.matcher).toBe("simple");
	expect(result.metadata).not.toHaveProperty("modifiedContent");
});

describe("ai_chat_tool_create_edit_file", () => {
	test("refuses before opening a write batch when the file disappears after preparation", async () => {
		const { ctx, runMutation } = makeCtx(
			async () => ({
				kind: "saved",
				node: { _id: "file_gone", kind: "file", assetId: "asset_edit", textKind: "plain_text" },
				path: "/gone.txt",
				pendingUpdate: null,
			}),
			{ runActionImpl: async (_ref, args) => (args.path ? null : { _yay: { pendingUpdate: null } }) },
		);
		const edit = ai_chat_tool_create_edit_file(ctx, server_ai_tools_test_ctx_data);
		await expect(
			edit.execute?.(
				{ path: "/gone.txt", oldString: "old", newString: "new", replaceAll: false },
				{ toolCallId: "gone", messages: [] },
			),
		).rejects.toThrow("the file changed while the edit was being prepared. Read it again.");
		expect(runMutation).not.toHaveBeenCalled();
	});

	test.each([false, true])(
		"recomputes once when the content family changes (second refusal: %s)",
		async (refuseAgain) => {
			let reads = 0;
			let writes = 0;
			const { ctx, runAction, runMutation } = makeCtx(
				async (_ref, args) =>
					args.path
						? {
								kind: "saved",
								node: { _id: "file_retry", kind: "file", assetId: "asset_edit", textKind: "plain_text" },
								path: args.path,
								pendingUpdate: null,
							}
						: { _id: "pending_retry" },
				{
					runMutationImpl: async () => ({ _yay: { operationBatchId: "batch_retry", expiresAt: Date.now() + 60_000 } }),
					runActionImpl: async (_ref, args) => {
						if (args.path) {
							reads += 1;
							return {
								target: { kind: "saved", id: "file_retry" },
								content: reads === 1 ? "old\n" : "saved\nold\n",
								pendingUpdateId: reads === 1 ? null : "pending_retry",
								pendingUpdateBaseStateId: reads === 1 ? undefined : "base_retry",
							};
						}
						if (args.operationBatchId) {
							writes += 1;
							return writes === 1 || refuseAgain
								? { _nay: { name: "pending_content_changed", message: "The proposal changed after it was read." } }
								: { _yay: {} };
						}
						return { _yay: { pendingUpdate: null } };
					},
				},
			);
			const edit = ai_chat_tool_create_edit_file(ctx, server_ai_tools_test_ctx_data);
			const result = edit.execute?.(
				{ path: "/retry.txt", oldString: "old", newString: "new", replaceAll: false },
				{ toolCallId: "retry", messages: [] },
			);
			if (refuseAgain) {
				await expect(result).rejects.toThrow("The proposal changed after it was read.");
			} else {
				await expect(result).resolves.toMatchObject({ metadata: { diff: " saved\n-old\n+new\n" } });
			}
			expect(reads).toBe(2);
			expect(writes).toBe(2);
			expect(runAction.mock.calls.map(([, args]) => args)).toMatchObject([
				{ target: { kind: "saved", id: "file_retry" } },
				{ path: "/retry.txt" },
				{ expectedBaseStateId: null },
				{ target: { kind: "saved", id: "file_retry" } },
				{ path: "/retry.txt" },
				{ expectedBaseStateId: "base_retry" },
			]);
			expect(
				runMutation.mock.calls.filter(([, args]) => args.role === "unstaged").map(([, args]) => args.text),
			).toEqual(["new\n", "saved\nnew\n"]);
		},
	);
});

test("replace_once_or_all: line-trimmed matching preserves the following newline", () => {
	const result = replace_once_or_all("before\n  alpha  \n  beta  \nafter", "alpha\nbeta", "gamma\ndelta");

	expect(result).toEqual({
		content: "before\ngamma\ndelta\nafter",
		matches: 1,
		matcher: "line_trimmed",
	});
});

test("replace_once_or_all: trimmed-boundary matching tolerates outer blank lines", () => {
	const result = replace_once_or_all("before\nalpha\nbeta\nafter", "\nalpha\nbeta\n", "gamma");

	expect(result).toEqual({
		content: "before\ngamma\nafter",
		matches: 1,
		matcher: "trimmed_boundary",
	});
});

test("replace_once_or_all: whitespace-normalized matching handles inline spacing differences", () => {
	const result = replace_once_or_all("before\nHello    brave   world\nafter", "Hello brave world", "Hi team");

	expect(result).toEqual({
		content: "before\nHi team\nafter",
		matches: 1,
		matcher: "whitespace_normalized",
	});
});

test("replace_once_or_all: indentation differences are still replaceable", () => {
	const result = replace_once_or_all(
		"before\n\t\tconst value = 1;\n\t\treturn value;\nafter",
		"const value = 1;\n\treturn value;",
		"const nextValue = 2;\n\treturn nextValue;",
	);

	expect(result.content).toBe("before\nconst nextValue = 2;\n\treturn nextValue;\nafter");
	expect(result.matches).toBe(1);
	expect(result.matcher).toBe("line_trimmed");
});

test("replace_once_or_all: escape-normalized matching handles escaped multiline strings", () => {
	const result = replace_once_or_all('"hello\\nworld"', '"hello\nworld"', '"hi there"');

	expect(result).toEqual({
		content: '"hi there"',
		matches: 1,
		matcher: "escape_normalized",
	});
});

test("replace_once_or_all: replaceAll uses the shared fallback pipeline", () => {
	const result = replace_once_or_all(
		"start\n  alpha  \n  beta  \nmid\n  alpha  \n  beta  \nend",
		"alpha\nbeta",
		"gamma\ndelta",
		{ replaceAll: true },
	);

	expect(result).toEqual({
		content: "start\ngamma\ndelta\nmid\ngamma\ndelta\nend",
		matches: 2,
		matcher: "line_trimmed",
	});
});

test("replace_once_or_all: throws a not-found error when there is no match", () => {
	expect(() => replace_once_or_all("alpha\nbeta", "missing", "gamma")).toThrow(
		"oldString not found in content. It must match exactly, including whitespace, indentation, and line endings.",
	);
});

test("replace_once_or_all: throws an ambiguity error when the match is not unique", () => {
	expect(() => replace_once_or_all("alpha\nalpha", "alpha", "gamma")).toThrow(
		"Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
	);
});

test("edit_file tool preserves the baseline trailing newline shape", async () => {
	const nodeId = "p789";
	const pendingUpdateId = "pending789";
	const currentContent = {
		target: { kind: "saved", id: nodeId },
		content: "Hello world\n",
		pendingUpdateId,
	};

	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) =>
			args.path
				? {
						kind: "saved",
						node: { _id: nodeId, kind: "file", assetId: "asset_edit", textKind: "plain_text" },
						path: args.path,
						pendingUpdate: null,
					}
				: { _id: pendingUpdateId },
		{
			// The upsert flow stages through internal mutations: batch create, then text input.
			runMutationImpl: async () => ({ _yay: { operationBatchId: "batch789", expiresAt: Date.now() + 60_000 } }),
			runActionImpl: async (_ref, args) => (args.path ? currentContent : { _yay: { pendingUpdate: null } }),
		},
	);
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/docs/newline.md",
			oldString: "world",
			newString: "team",
			replaceAll: false,
		},
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	const [, firstQueryArgs] = runAction.mock.calls[1]!;
	expect(firstQueryArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/newline.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});

	// The trailing-newline shape rides on the staged text input, not on the finishing action.
	const [, stagedTextArgs] = runMutation.mock.calls[1]!;
	expect(stagedTextArgs).toMatchObject({
		role: "unstaged",
		text: "Hello team\n",
	});

	expect(result.metadata.matcher).toBe("simple");
});

test("edit_file edits a plain text .json file and stages the exact text", async () => {
	const nodeId = "p901";
	const pendingUpdateId = "pending901";
	const currentContent = {
		target: { kind: "saved", id: nodeId },
		content: '{"port": 9090}',
		pendingUpdateId,
	};

	const { ctx, runMutation } = makeCtx(
		async (_ref, args) =>
			args.path
				? {
						kind: "saved",
						node: { _id: nodeId, kind: "file", assetId: "asset_edit", textKind: "plain_text" },
						path: args.path,
						pendingUpdate: null,
					}
				: { _id: pendingUpdateId },
		{
			runMutationImpl: async () => ({ _yay: { operationBatchId: "batch901", expiresAt: Date.now() + 60_000 } }),
			runActionImpl: async (_ref, args) => (args.path ? currentContent : { _yay: { pendingUpdate: null } }),
		},
	);
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/data/config.json",
			oldString: '"port": 9090',
			newString: '"port": 8080',
			replaceAll: false,
		},
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The plain-text contract is byte-exact: the staged text is the edited JSON, with no rewrite and
	// no appended newline (the baseline had none).
	const [, stagedTextArgs] = runMutation.mock.calls[1]!;
	expect(stagedTextArgs).toMatchObject({
		role: "unstaged",
		text: '{"port": 8080}',
	});
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.matches).toBe(1);
});

test("edit_file describes and preserves a terminal read-only refusal", async () => {
	const currentContent = {
		target: { kind: "saved", id: "file_read_only" },
		content: "before",
		pendingUpdateId: null,
	};
	const { ctx, runAction, runMutation } = makeCtx(
		async () => ({
			kind: "saved",
			node: { _id: currentContent.target.id, kind: "file", assetId: "asset_edit", textKind: "plain_text" },
			path: "/docs/locked.md",
			pendingUpdate: null,
		}),
		{
			runActionImpl: async () => ({ _nay: { name: "read_only", message: "This item is read-only." } }),
		},
	);
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);

	expect(tool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining(
				"A read-only refusal is terminal for this edit. Do not retry the path with bash redirects, tee, cp, mv, or another write tool",
			),
		}),
	);
	await expect(
		tool.execute?.(
			{ path: "/docs/locked.md", oldString: "before", newString: "after", replaceAll: false },
			{ toolCallId: "test", messages: [] },
		),
	).rejects.toThrow(
		"Cannot edit /docs/locked.md: This item is read-only. Do not retry this path with another write tool.",
	);
	expect(runAction).toHaveBeenCalledTimes(1);
	expect(runMutation).not.toHaveBeenCalled();
});

test.each(["saved", "private"])("edit_file's refusal names the %s content type, not the path", async (kind) => {
	// A stored image has no text. Its node lookup lets the refusal name the stored type.
	const { ctx, runAction, runQuery } = makeCtx(
		async () => ({
			kind,
			node: { kind: "file", contentType: "image/png", assetId: "asset_image", textKind: null },
			path: "/assets/photo.png",
			pendingUpdate: kind === "saved" ? null : { createIntent: { kind: "stored", contentType: "image/png" } },
		}),
		{ runActionImpl: async (_ref, args) => (args.path ? null : { _yay: { pendingUpdate: null } }) },
	);
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);

	// A stored file must refuse with its stored type, not with "File not found": the file
	// exists, and a not-found answer sends the model into a wrong retry loop. The name never
	// decides this: a Markdown file called `photo.png` would edit fine.
	await expect(
		tool.execute?.(
			{ path: "/assets/photo.png", oldString: "a", newString: "b", replaceAll: false },
			{ toolCallId: "test", messages: [] },
		),
	).rejects.toThrow(
		/Cannot edit \/assets\/photo\.png: this file's content type \('image\/png'\) is not editable as text/,
	);

	expect(runAction).not.toHaveBeenCalled();
	expect(runQuery).toHaveBeenCalledTimes(1);
});

describe("ai_chat_tool_create_set_file_metadata", () => {
	const makeTool = (runMutationImpl: (ref: any, args: any) => Promise<any>) => {
		const { ctx, runMutation } = makeCtx(async () => null, { runMutationImpl });
		const tool = ai_chat_tool_create_set_file_metadata(
			ctx,
			server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_set_file_metadata>[1],
		);
		return { tool, runMutation };
	};

	const run = (tool: ReturnType<typeof ai_chat_tool_create_set_file_metadata>, path: string) =>
		tool.execute?.(
			{ path, set: [{ key: "created-by", value: "agent" }], remove: [] },
			{ toolCallId: "test", messages: [] },
		);

	// Live QA caught this: without the rule the model pastes the bash mount path straight from
	// `meta get` output, and the write answers "Not found" three times before it recovers.
	test("tells the model to strip the bash workspace prefix from a path", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_set_file_metadata(
			ctx,
			server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_set_file_metadata>[1],
		);

		expect(tool.description).toContain(
			"remove the /home/cloud-usr/w/<organization>/<workspace> current workspace path prefix",
		);
		expect(tool.description).toContain(
			"/home/cloud-usr/w/personal/home/folder/README.md becomes /folder/README.md, never /README.md.",
		);
	});

	// `meta get` prints `frontmatter.status` next to `metadata.owner`. The write tool already
	// tells the model to strip `metadata.` and pass the bare key. Without the same warning for
	// `frontmatter.`, the grammar refusal trains a retry as `status`, which writes the other store.
	test("tells the model this tool does not write Markdown frontmatter", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_set_file_metadata(
			ctx,
			server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_set_file_metadata>[1],
		);

		expect(tool.description).toMatch(/frontmatter/i);
	});

	test("refuses the root and the read-only mounts before writing", async () => {
		const { tool, runMutation } = makeTool(async () => ({ _yay: { path: "/x", entries: [] } }));

		await expect(run(tool, "/")).rejects.toThrow("Path must be absolute and not root.");
		await expect(run(tool, "/.mounts/gmail/inbox.md")).rejects.toThrow("read-only mount of an external source");
		await expect(run(tool, "/.plugins/chitchat/README.md")).rejects.toThrow(
			"read-only mount of installed plugin sources",
		);
		expect(runMutation).not.toHaveBeenCalled();
	});

	// Same as edit_file: a relative path is read as app-relative and made absolute, not refused.
	test("makes a relative path absolute instead of refusing it", async () => {
		const { tool, runMutation } = makeTool(async () => ({ _yay: { path: "/docs/hello.md", entries: [] } }));

		await run(tool, "docs/hello.md");

		const [, mutationArgs] = runMutation.mock.calls[0]!;
		expect(mutationArgs.path).toBe("/docs/hello.md");
	});

	test.each(["/docs/hello.md", "/docs"])(
		"writes the set and remove lists at %s and reports the stored map",
		async (path) => {
			const { tool, runMutation } = makeTool(async () => ({
				_yay: {
					path,
					entries: [
						{ key: "created-by", value: "agent" },
						{ key: "priority", value: 3 },
						{ key: "archived", value: false },
					],
				},
			}));

			const result = await tool.execute?.(
				{ path, set: [{ key: "created-by", value: "agent" }], remove: ["stale"] },
				{ toolCallId: "test", messages: [] },
			);

			const [, mutationArgs] = runMutation.mock.calls[0]!;
			expect(mutationArgs).toMatchObject({
				path,
				set: [{ key: "created-by", value: "agent" }],
				remove: ["stale"],
			});
			expect(result).toMatchObject({
				title: path,
				metadata: { path },
				output: 'created-by = "agent"\npriority = 3\narchived = false',
			});
		},
	);

	test.each(["/docs/hello.md", "/docs"])("reports an empty map after removing the last key at %s", async (path) => {
		const { tool } = makeTool(async () => ({ _yay: { path, entries: [] } }));

		const result = await tool.execute?.(
			{ path, set: [], remove: ["created-by"] },
			{ toolCallId: "test", messages: [] },
		);

		expect(result).toMatchObject({ output: "This item has no metadata now." });
	});

	// A read-only refusal is terminal: retrying the same path with another write tool cannot work,
	// and the model has to be told that or it keeps trying.
	test("tells the model not to retry a read-only file, and surfaces other refusals as they are", async () => {
		const readOnly = makeTool(async () => ({
			_nay: { name: "read_only", message: "This item is read-only." },
		}));
		await expect(run(readOnly.tool, "/docs/hello.md")).rejects.toThrow(
			"Cannot set metadata on /docs/hello.md: This item is read-only. Do not retry this path with another write tool.",
		);

		const missing = makeTool(async () => ({ _nay: { name: "nay", message: "Not found" } }));
		await expect(run(missing.tool, "/docs/gone.md")).rejects.toThrow("Cannot set metadata on /docs/gone.md: Not found");
	});
});

test("web_search tool: Exa SDK uses fast search, highlights, and returns compact output", async () => {
	const prevKey = process.env.EXA_API_KEY;
	process.env.EXA_API_KEY = "test-exa-key";

	exa_test.searchMock.mockResolvedValue({
		requestId: "req_test",
		results: [
			{
				title: "Example",
				url: "https://example.com/doc",
				id: "https://example.com/doc",
				highlights: ["First snippet.", "Second snippet."],
			},
		],
	});

	try {
		const tool = ai_chat_tool_create_web_search();
		const result = await tool.execute?.(
			{
				query: "convex auth",
				numResults: 7,
				includeDomains: ["exa.ai"],
				excludeDomains: ["spam.test"],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		);

		if (!result) {
			throw new Error("`result` is undefined");
		}
		if (!isNotAsyncIterable(result)) {
			throw new Error("`result` is AsyncIterable but expected sync object");
		}

		expect(exa_test.lastApiKey).toBe("test-exa-key");
		expect(exa_test.searchMock).toHaveBeenCalledTimes(1);
		expect(exa_test.searchMock).toHaveBeenCalledWith("convex auth", {
			type: "fast",
			numResults: 7,
			includeDomains: ["exa.ai"],
			excludeDomains: ["spam.test"],
			contents: { highlights: { maxCharacters: 4000 } },
		});

		expect(result.title).toBe("Web search");
		expect(result.metadata).toEqual({
			query: "convex auth",
			resultCount: 1,
			requestId: "req_test",
		});
		expect(result.output).toContain("Example");
		expect(result.output).toContain("https://example.com/doc");
		expect(result.output).toContain("First snippet.");
	} finally {
		exa_test.searchMock.mockClear();
		exa_test.lastApiKey = undefined;
		if (prevKey === undefined) {
			delete process.env.EXA_API_KEY;
		} else {
			process.env.EXA_API_KEY = prevKey;
		}
	}
});

type execute_code_test_runner_response = Response;

function execute_code_test_make_response(status: number, body: unknown): execute_code_test_runner_response {
	return Response.json(body, { status });
}

async function execute_code_test_with_runner(
	args: {
		url?: string;
		secret?: string;
		appOrigin?: string;
		fetchImpl?: (...fetchArgs: unknown[]) => Promise<execute_code_test_runner_response>;
	},
	run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
) {
	const prevUrl = process.env.CODE_EXECUTION_RUNNER_URL;
	const prevSecret = process.env.CODE_EXECUTION_RUNNER_SECRET;
	const prevConvexHttpUrl = process.env.VITE_CONVEX_HTTP_URL;

	if (args.url === undefined) {
		delete process.env.CODE_EXECUTION_RUNNER_URL;
	} else {
		process.env.CODE_EXECUTION_RUNNER_URL = args.url;
	}
	if (args.secret === undefined) {
		delete process.env.CODE_EXECUTION_RUNNER_SECRET;
	} else {
		process.env.CODE_EXECUTION_RUNNER_SECRET = args.secret;
	}
	process.env.VITE_CONVEX_HTTP_URL = args.appOrigin ?? "https://app.test";

	const fetchMock = vi.fn(args.fetchImpl ?? (async () => execute_code_test_make_response(200, {})));
	vi.stubGlobal("fetch", fetchMock);

	try {
		await run(fetchMock);
	} finally {
		vi.unstubAllGlobals();
		if (prevUrl === undefined) {
			delete process.env.CODE_EXECUTION_RUNNER_URL;
		} else {
			process.env.CODE_EXECUTION_RUNNER_URL = prevUrl;
		}
		if (prevSecret === undefined) {
			delete process.env.CODE_EXECUTION_RUNNER_SECRET;
		} else {
			process.env.CODE_EXECUTION_RUNNER_SECRET = prevSecret;
		}
		if (prevConvexHttpUrl === undefined) {
			delete process.env.VITE_CONVEX_HTTP_URL;
		} else {
			process.env.VITE_CONVEX_HTTP_URL = prevConvexHttpUrl;
		}
	}
}

function execute_code_test_make_tool() {
	const { ctx, runMutation, runAction } = makeCtx(async () => null);
	return {
		tool: ai_chat_tool_create_execute_code(
			ctx,
			server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_execute_code>[1],
		),
		runMutation,
		runAction,
	};
}

test("execute_code tool: describes app file API reads", () => {
	const { tool } = execute_code_test_make_tool();

	expect(tool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining("/api/v1/files/read-many"),
		}),
	);
	expect(tool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining("run file API fetches inside the snippet"),
		}),
	);
});

describe("runner cancellation", () => {
	test("Stop aborts the execute_code fetch", async () => {
		const abort = new AbortController();
		let notifyFetch!: () => void;
		const fetched = new Promise<void>((resolve) => {
			notifyFetch = resolve;
		});
		let fetchWasAborted = false;
		await execute_code_test_with_runner(
			{
				url: "https://runner.test",
				secret: "test-runner-secret",
				fetchImpl: async (...args) => {
					const init = args[1] as RequestInit;
					notifyFetch();
					expect(init.signal).toBe(abort.signal);
					return await new Promise<execute_code_test_runner_response>((_resolve, reject) => {
						init.signal?.addEventListener(
							"abort",
							() => {
								fetchWasAborted = true;
								reject(init.signal?.reason);
							},
							{ once: true },
						);
					});
				},
			},
			async () => {
				const { ctx } = makeCtx(async () => null);
				const options = { toolCallId: "abort-call", messages: [], abortSignal: abort.signal };
				const operation = ai_chat_tool_create_execute_code(ctx, server_ai_tools_test_ctx_data).execute?.(
					{ code: "return 2 + 2;" },
					options,
				);
				const rejected = expect(operation).rejects.toThrow("Stop");
				await fetched;
				abort.abort(new Error("Stop"));
				await rejected;
				expect(fetchWasAborted).toBe(true);
			},
		);
	});
});

test("execute_code tool: posts to the runner and formats a succeeded result with logs", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test/",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_1",
					status: "succeeded",
					codeHash: "hash_1",
					elapsedMs: 3,
					result: 4,
					resultTruncated: false,
					logs: ["hello"],
					logsTruncated: false,
					files: [],
					error: null,
				}),
		},
		async (fetchMock) => {
			const { tool, runMutation, runAction } = execute_code_test_make_tool();
			const result = await tool.execute?.(
				{ code: "return input.n * 2;", input: { n: 2, label: "payment-001" } },
				{ toolCallId: "tool-call-1", messages: [] },
			);

			if (!result) {
				throw new Error("`result` is undefined");
			}
			if (!isNotAsyncIterable(result)) {
				throw new Error("`result` is AsyncIterable but expected sync object");
			}

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toBe("https://runner.test/internal/execute-code");
			expect(calledInit.method).toBe("POST");
			expect((calledInit.headers as Record<string, string>).Authorization).toBe("Bearer test-runner-secret");
			const runnerBody = JSON.parse(calledInit.body as string);
			expect(runnerBody).toEqual({
				executionId: expect.any(String),
				code: "return input.n * 2;",
				input: { n: 2, label: "payment-001" },
				network: { mode: "public_http" },
				app: {
					origin: "https://app.test",
					token: expect.any(String),
				},
			});
			expect(runMutation).toHaveBeenCalledTimes(1);
			expect(runMutation.mock.calls[0]?.[1]).toEqual({
				organizationId: test_mocks_hardcoded.organization_id.organization_1,
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				userId: server_ai_tools_test_user_id,
				threadId: server_ai_tools_test_thread_id,
				principalKey: runnerBody.executionId,
				tokenHash: expect.any(String),
				scopes: ["files:list", "files:read", "files:download"],
				pathPrefix: null,
				now: expect.any(Number),
			});
			expect(runAction).not.toHaveBeenCalled();

			expect(result.title).toBe("Execute code");
			expect(result.metadata.status).toBe("succeeded");
			expect(result.output).toContain("Result: 4");
			expect(result.output).toContain("hello");
		},
	);
});

describe("ai_chat_tool_create_execute_code", () => {
	const runnerResult = {
		executionId: "binary-execution",
		status: "succeeded",
		codeHash: "binary-code",
		elapsedMs: 3,
		result: 4,
		resultTruncated: false,
		logs: ["Created files"],
		logsTruncated: false,
		error: null,
	};
	const binaryFile = { path: "/exports/binary", dataBase64: "AP+AAQ==" };

	afterEach(() => vi.restoreAllMocks());

	test.each([false, true])(
		"keeps exact bytes and reports partial writes when second prepare fails: %s",
		async (failSecond) => {
			vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
				key,
				url: "https://r2.test/" + key,
			}));
			vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
			await execute_code_test_with_runner(
				{
					url: "https://runner.test",
					secret: "test-runner-secret",
					fetchImpl: async (url) =>
						url === "https://runner.test/internal/execute-code"
							? Response.json({
									...runnerResult,
									files: [binaryFile, { path: "/exports/empty", contentType: "application/x-custom", dataBase64: "" }],
								})
							: new Response(null),
				},
				async (fetchMock) => {
					const { ctx, runMutation } = makeCtx(async () => null);
					const first = { kind: "private" as const, id: "private-1" };
					const second = { kind: "private" as const, id: "private-2" };
					runMutation
						.mockResolvedValueOnce(null)
						.mockResolvedValueOnce({
							_yay: { kind: "stored", receiptId: "receipt-1", assetId: "asset-1", r2Key: "file-1" },
						})
						.mockResolvedValueOnce({
							_yay: { target: first, path: binaryFile.path, size: 4, contentType: "application/octet-stream" },
						});
					if (failSecond) runMutation.mockResolvedValueOnce({ _nay: { message: "Quota exceeded" } });
					else
						runMutation
							.mockResolvedValueOnce({
								_yay: { kind: "stored", receiptId: "receipt-2", assetId: "asset-2", r2Key: "file-2" },
							})
							.mockResolvedValueOnce({
								_yay: { target: second, path: "/exports/empty", size: 0, contentType: "application/x-custom" },
							});
					const tool = ai_chat_tool_create_execute_code(ctx, server_ai_tools_test_ctx_data);
					const result = await tool.execute?.(
						{ code: "emitFile({ path: '/exports/binary', bytes: new Uint8Array([0, 255, 128, 1]) }); return 4;" },
						{ toolCallId: "binary-call", messages: [] },
					);

					expect(runMutation).toHaveBeenCalledTimes(failSecond ? 4 : 5);
					expect(getFunctionName(runMutation.mock.calls[1]?.[0])).toBe("ai_chat_files:prepare_file_output");
					expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
						userId: server_ai_tools_test_ctx_data.userId,
						membershipId: server_ai_tools_test_ctx_data.membershipId,
						threadId: server_ai_tools_test_thread_id,
						modeId: "agent",
						path: "/exports/binary",
						contentType: "application/octet-stream",
						size: 4,
						content: { kind: "stored" },
						requestId: expect.any(String),
						attemptId: expect.any(String),
						digest: expect.any(String),
					});
					expect(fetchMock).toHaveBeenCalledWith(
						"https://r2.test/file-1",
						expect.objectContaining({ method: "PUT", body: new Uint8Array([0, 255, 128, 1]) }),
					);
					if (!failSecond)
						expect(fetchMock).toHaveBeenCalledWith(
							"https://r2.test/file-2",
							expect.objectContaining({ method: "PUT", body: new Uint8Array(0) }),
						);
					const targets = failSecond ? [first] : [first, second];
					expect(result).toMatchObject({
						title: "Execute code",
						output: expect.stringContaining("Result: 4\n\nLogs:\n  Created files"),
						metadata: {
							status: "succeeded",
							files: targets,
							fileResult: ai_chat_file_result(
								"File output",
								failSecond ? "partial" : "succeeded",
								targets,
								failSecond ? "storage" : null,
							),
						},
					});
					expect(JSON.stringify(result)).not.toContain("dataBase64");
					expect(JSON.stringify(result)).not.toContain(binaryFile.dataBase64);
					expect(JSON.stringify(result)).not.toContain("r2.test");
				},
			);
		},
	);

	test("refuses Ask file output before reserving assets or uploading", async () => {
		await execute_code_test_with_runner(
			{
				url: "https://runner.test",
				secret: "test-runner-secret",
				fetchImpl: async () => Response.json({ ...runnerResult, files: [binaryFile] }),
			},
			async (fetchMock) => {
				const { ctx, runMutation } = makeCtx(async () => null);
				const tool = ai_chat_tool_create_execute_code(ctx, { ...server_ai_tools_test_ctx_data, canWriteFiles: false });

				expect(await tool.execute?.({ code: "return 4;" }, { toolCallId: "ask-call", messages: [] })).toMatchObject({
					metadata: {
						status: "succeeded",
						files: [],
						fileResult: ai_chat_file_result("File output", "errored", [], "agent_required"),
					},
				});

				// Only the file API grant ran. Ask still gets that grant, but with read scopes alone, so the
				// snippet can read files and never write them.
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(runMutation).toHaveBeenCalledTimes(1);
				expect(getFunctionName(runMutation.mock.calls[0]?.[0])).toBe("public_api:create_grant");
				expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
					scopes: ["files:list", "files:read", "files:download"],
				});
			},
		);
	});

	test("Stop after the runner reply prevents file reservation and upload", async () => {
		const abort = new AbortController();
		await execute_code_test_with_runner(
			{
				url: "https://runner.test",
				secret: "test-runner-secret",
				fetchImpl: async () => {
					abort.abort(new Error("Stop"));
					return Response.json({ ...runnerResult, files: [binaryFile] });
				},
			},
			async (fetchMock) => {
				const { tool, runMutation } = execute_code_test_make_tool();

				expect(
					await tool.execute?.(
						{ code: "return 4;" },
						{ toolCallId: "stopped-call", messages: [], abortSignal: abort.signal },
					),
				).toMatchObject({ metadata: { fileResult: ai_chat_file_result("File output", "cancelled") } });

				// The runner already replied with files, but Stop came first. Nothing may be reserved or
				// uploaded after that, so only the file API grant ran.
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(runMutation).toHaveBeenCalledTimes(1);
				expect(getFunctionName(runMutation.mock.calls[0]?.[0])).toBe("public_api:create_grant");
			},
		);
	});

	test("cancels an error response above 64 KiB and keeps the status fallback", async () => {
		const cancel = vi.fn();
		await execute_code_test_with_runner(
			{
				url: "https://runner.test",
				secret: "test-runner-secret",
				fetchImpl: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(JSON.stringify({ error: { message: "x".repeat(64 * 1024) } })),
								);
							},
							cancel,
						}),
						{ status: 500 },
					),
			},
			async () => {
				const { tool } = execute_code_test_make_tool();

				await expect(tool.execute?.({ code: "return 4;" }, { toolCallId: "error-call", messages: [] })).rejects.toThrow(
					"Code execution request failed (500).",
				);

				// The error body is read only up to a fixed size. A bigger body is cancelled instead of being
				// pulled into memory, and the message then falls back to the status code.
				expect(cancel).toHaveBeenCalledTimes(1);
			},
		);
	});

	// The runner is a separate service, so its reply is untrusted input. Every broken shape below must
	// be refused before any storage is reserved. Files after a failed or timed out run are refused too,
	// because files leave the sandbox only on success.
	test.each([
		{ name: "missing files", change: {} },
		{ name: "extra file fields", change: { files: [{ ...binaryFile, bytes: [0, 255] }] } },
		{ name: "non-string base64", change: { files: [{ ...binaryFile, dataBase64: 10 }] } },
		{ name: "invalid base64", change: { files: [{ ...binaryFile, dataBase64: "!!!!" }] } },
		{ name: "non-canonical base64", change: { files: [{ ...binaryFile, dataBase64: "AB==" }] } },
		{ name: "missing padding", change: { files: [{ ...binaryFile, dataBase64: "AA" }] } },
		{ name: "nine files", change: { files: Array.from({ length: 9 }, () => binaryFile) } },
		{ name: "failed execution files", change: { status: "errored", files: [binaryFile] } },
		{ name: "timed out execution files", change: { status: "timed_out", files: [binaryFile] } },
		{
			name: "over 8 MiB in one file",
			change: { files: [{ ...binaryFile, dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }] },
		},
		{
			name: "over 8 MiB total",
			change: {
				files: [
					{ ...binaryFile, dataBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") },
					{ ...binaryFile, path: "exports/second", dataBase64: Buffer.alloc(4 * 1024 * 1024).toString("base64") },
				],
			},
		},
	])("refuses $name before reserving assets", async ({ change }) => {
		await execute_code_test_with_runner(
			{
				url: "https://runner.test",
				secret: "test-runner-secret",
				fetchImpl: async () => Response.json({ ...runnerResult, ...change }),
			},
			async (fetchMock) => {
				const { tool, runMutation } = execute_code_test_make_tool();

				await expect(
					tool.execute?.({ code: "return 4;" }, { toolCallId: "invalid-call", messages: [] }),
				).rejects.toThrow("Code execution returned an invalid response.");

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(runMutation).toHaveBeenCalledTimes(1);
				expect(getFunctionName(runMutation.mock.calls[0]?.[0])).toBe("public_api:create_grant");
			},
		);
	});
});

test("execute_code tool: formats an errored result", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_2",
					status: "errored",
					codeHash: "hash_2",
					elapsedMs: 1,
					result: null,
					resultTruncated: false,
					logs: [],
					logsTruncated: false,
					files: [],
					error: { name: "TypeError", message: "boom" },
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			const result = await tool.execute?.({ code: "throw new TypeError('boom');" }, { toolCallId: "t", messages: [] });
			if (!result || !isNotAsyncIterable(result)) {
				throw new Error("unexpected result");
			}
			expect(result.metadata.status).toBe("errored");
			expect(result.output).toContain("Error: TypeError: boom");
		},
	);
});

test("execute_code tool: formats a timed_out result", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_3",
					status: "timed_out",
					codeHash: "hash_3",
					elapsedMs: 5000,
					result: null,
					resultTruncated: false,
					logs: [],
					logsTruncated: false,
					files: [],
					error: { name: "TimeoutError", message: "Execution timed out." },
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			const result = await tool.execute?.({ code: "while (true) {}" }, { toolCallId: "t", messages: [] });
			if (!result || !isNotAsyncIterable(result)) {
				throw new Error("unexpected result");
			}
			expect(result.metadata.status).toBe("timed_out");
			expect(result.output).toContain("timed out");
		},
	);
});

test("execute_code tool: always sends gatewayed network and app runtime", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test/",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_net",
					status: "succeeded",
					codeHash: "hash_net",
					elapsedMs: 3,
					result: "ok",
					resultTruncated: false,
					logs: [],
					logsTruncated: false,
					files: [],
					error: null,
				}),
		},
		async (fetchMock) => {
			const { tool } = execute_code_test_make_tool();
			const result = await tool.execute?.(
				{ code: "return await fetch('https://example.com').then(r => r.text());" },
				{ toolCallId: "tool-call-net", messages: [] },
			);

			if (!result) {
				throw new Error("`result` is undefined");
			}
			if (!isNotAsyncIterable(result)) {
				throw new Error("`result` is AsyncIterable but expected sync object");
			}

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(JSON.parse(calledInit.body as string)).toEqual(
				expect.objectContaining({
					code: "return await fetch('https://example.com').then(r => r.text());",
					input: null,
					network: { mode: "public_http" },
					app: { origin: "https://app.test", token: expect.any(String) },
				}),
			);
		},
	);
});

test("execute_code tool: throws when the runner is not configured", async () => {
	await execute_code_test_with_runner({ url: undefined, secret: undefined }, async (fetchMock) => {
		const { tool } = execute_code_test_make_tool();
		await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
			"Code execution is unavailable.",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

test("execute_code tool: throws when the app origin is invalid", async () => {
	await execute_code_test_with_runner(
		{ url: "https://runner.test", secret: "test-runner-secret", appOrigin: "http://app.test" },
		async (fetchMock) => {
			const { tool, runMutation } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"Code execution app access is unavailable.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(runMutation).not.toHaveBeenCalled();
		},
	);
});

test("execute_code tool: surfaces the disabled kill switch", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(503, {
					ok: false,
					error: { code: "disabled", message: "Code execution is disabled." },
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"Code execution is disabled.",
			);
		},
	);
});

test("execute_code tool: surfaces a non-OK runner error, falling back to the status code", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(500, { ok: false, error: { code: "internal", message: "runner boom" } }),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"runner boom",
			);
		},
	);

	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () => new Response("not json", { status: 502 }),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow("(502)");
		},
	);
});

test("execute_code tool: surfaces runner outbound misconfiguration", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(503, {
					ok: false,
					error: {
						code: "misconfigured",
						message: "Code execution outbound access is unavailable.",
					},
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"outbound access is unavailable",
			);
		},
	);
});

test("execute_code tool: inputSchema rejects empty and oversize code", () => {
	const { tool } = execute_code_test_make_tool();
	const schema = tool.inputSchema;
	if (!has_defined_property(schema, "parse")) {
		throw new Error("inputSchema has no parse");
	}
	expect(() => schema.parse({ code: "" })).toThrow();
	expect(() => schema.parse({ code: "a".repeat(20_001) })).toThrow();
	expect(schema.parse({ code: "return 1;" })).toEqual({ code: "return 1;" });
});

describe("browser tools", () => {
	const runnerQueue: Array<unknown> = [];
	const runnerCalls: Array<{ route: string; body: Record<string, unknown> }> = [];
	const r2Objects = new Map<string, Uint8Array>();
	const browserCtxData = {
		...server_ai_tools_test_ctx_data,
		browser: {
			membershipId: "membership-1" as Id<"organizations_workspaces_users">,
			sessionId: "session-1" as Id<"files_browser_sessions">,
			navGen: 1,
			loadGen: 1,
			controlGen: 1,
		},
		observations: new Map<string, ai_chat_Observation>(),
	};
	const accessOk = {
		ok: true,
		control: "ready",
		controlGen: 1,
		loadGen: 1,
		navGen: 1,
		runnerSessionId: "runner-session-1",
		targetKind: "saved",
		nodeId: "node-1",
		sourceKind: "saved",
		sourceVersion: "v1",
		sourceHash: "hash",
	};
	const binaryFile = { path: "/reports/output.bin", dataBase64: "AP+AAQ==" };

	function runner_run_result(overrides: Record<string, unknown> = {}) {
		return {
			ok: true,
			status: "succeeded",
			elapsedMs: 100,
			result: { reviewed: true },
			resultTruncated: false,
			files: [],
			consoleEntries: [],
			pageErrors: [],
			logs: [],
			logsTruncated: false,
			error: null,
			...overrides,
		};
	}

	beforeEach(() => {
		runnerQueue.length = 0;
		runnerCalls.length = 0;
		r2Objects.clear();
		browserCtxData.observations.clear();
		Object.assign(browserCtxData.browser, { navGen: 1, loadGen: 1, controlGen: 1 });
		process.env.BROWSER_RUN_ENABLED = "true";
		process.env.BROWSER_RUNNER_URL = "https://browser-runner.test";
		process.env.BROWSER_RUNNER_SECRET = "secret";
		vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
			key,
			url: "https://r2.test/upload?key=" + encodeURIComponent(key),
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.startsWith("https://browser-runner.test/")) {
					const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
					runnerCalls.push({ route: url.slice(url.lastIndexOf("/") + 1), body });
					const next = runnerQueue.shift();
					if (!next || typeof next !== "object") throw new Error("Runner mock queue is empty");
					// The real runner binds every reply to the exact command and code.
					return Response.json({
						commandId: body.commandId,
						codeHash: await crypto_sha256_hex(`browser-v2\n${String(body.code)}`),
						...next,
					});
				}
				if (url.startsWith("https://r2.test/upload") && init?.method === "PUT") {
					if (!(init.body instanceof Uint8Array)) throw new Error("Expected raw upload bytes");
					r2Objects.set(new URL(url).searchParams.get("key") ?? "", new Uint8Array(init.body));
					return new Response(null);
				}
				throw new Error("Unexpected fetch: " + url.slice(0, 120));
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete process.env.BROWSER_RUN_ENABLED;
		delete process.env.BROWSER_RUNNER_URL;
		delete process.env.BROWSER_RUNNER_SECRET;
	});

	test("browser_run exposes only code in its provider schema", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		const tool = ai_chat_tool_create_browser_run(ctx, browserCtxData);
		const schema = tool.inputSchema;
		if (!has_defined_property(schema, "parse")) throw new Error("Expected Zod schema");
		expect(schema.parse({ code: "return 1;" })).toEqual({ code: "return 1;" });
		for (const input of [
			{ code: "" },
			{ code: "a".repeat(20_001) },
			{ code: "return 1;", saveDir: null },
			{ code: "return 1;", savePath: "/report.png" },
		])
			expect(() => schema.parse(input)).toThrow();
		expect(await asSchema(schema).jsonSchema).toMatchObject({
			type: "object",
			required: ["code"],
			additionalProperties: false,
			properties: { code: { type: "string", minLength: 1, maxLength: 20_000 } },
		});
		expect(Object.keys((await asSchema(schema).jsonSchema).properties ?? {})).toEqual(["code"]);
	});

	test.each([
		{ ok: false, reason: "closed" },
		{ ...accessOk, controlGen: 2 },
		{ ...accessOk, loadGen: 2 },
		{ ...accessOk, control: "human" },
	])("refuses unavailable or changed control before calling the runner", async (access) => {
		const { ctx } = makeCtx(async () => access);
		const tool = ai_chat_tool_create_browser_run(ctx, browserCtxData);
		expect(await tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).toMatchObject({
			metadata: { status: "errored", reason: "stale", files: [] },
		});
		expect(runnerCalls).toEqual([]);
	});

	test("accepts the real runner's versioned code hash", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		const code = "return 1;";
		// The runner includes its harness version in the hash used for its cached child Worker.
		runnerQueue.push(runner_run_result({ codeHash: await crypto_sha256_hex(`browser-v2\n${code}`) }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code },
				{ toolCallId: "versioned-hash", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "succeeded", [], null, {
				code,
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
	});

	test("stores capped display text while live observations stay live-only", async () => {
		const { ctx, runQuery, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ result: "private DOM text", consoleEntries: ["private console"] }));
		const tool = ai_chat_tool_create_browser_run(ctx, browserCtxData);
		const input = { code: "return await frame.textContent('body');" };
		const output = ai_chat_file_result_schema.parse(await tool.execute?.(input, { toolCallId: "t", messages: [] }));
		expect(output).toEqual(
			ai_chat_file_result("Browser run", "succeeded", [], null, {
				code: input.code,
				resultText: "private DOM text",
				consoleText: "private console",
			}),
		);
		expect(JSON.stringify(output)).not.toContain("dataBase64");
		expect(JSON.stringify(output)).not.toContain("commandId");
		expect(JSON.stringify(output)).not.toContain("runner-session-1");
		const reads = runQuery.mock.calls.length;
		const observation = browserCtxData.observations.get("t");
		for (let count = 0; count < 2; count++) {
			const converted = await tool.toModelOutput?.({ toolCallId: "t", input, output });
			expect(JSON.stringify(converted)).toContain("private DOM text");
			expect(JSON.stringify(converted)).toContain("private console");
		}
		expect(runQuery).toHaveBeenCalledTimes(reads);
		expect(runMutation).not.toHaveBeenCalled();
		expect(browserCtxData.observations.get("t")).toBe(observation);
		expect(browserCtxData.observations.size).toBe(1);
		expect(await observation?.isCurrent()).toBe(true);
	});

	test("bounds live console and page errors", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		runnerQueue.push(
			runner_run_result({
				consoleEntries: Array.from({ length: 100 }, () => "x".repeat(10_000)),
				pageErrors: Array.from({ length: 100 }, () => "y".repeat(10_000)),
			}),
		);
		await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
			{ code: "return 1;" },
			{ toolCallId: "t", messages: [] },
		);
		const observation = JSON.stringify(browserCtxData.observations.get("t")?.output);
		expect(observation).toContain("Console:");
		expect(observation).toContain("Page errors:");
		expect(observation.length).toBeLessThan(10_000);
	});

	test.each([
		{ name: "malformed", reply: { ok: true } },
		{ name: "wrong command", reply: runner_run_result({ commandId: "other" }) },
		{ name: "wrong code", reply: runner_run_result({ codeHash: "other" }) },
		{ name: "nine files", reply: runner_run_result({ files: Array.from({ length: 9 }, () => binaryFile) }) },
		{ name: "extra file field", reply: runner_run_result({ files: [{ ...binaryFile, bytes: [1] }] }) },
		{ name: "failed run with files", reply: runner_run_result({ status: "errored", files: [binaryFile] }) },
		{ name: "timeout with files", reply: runner_run_result({ status: "timed_out", files: [binaryFile] }) },
	])("refuses $name without publishing", async ({ reply }) => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(reply);
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toMatchObject({ metadata: { status: "errored", reason: "invalid_result", files: [] } });
		expect(runMutation).not.toHaveBeenCalled();
		expect(browserCtxData.observations.size).toBe(0);
	});

	test.each(["!!!!", "AB==", "AA"])("refuses invalid base64 %s before storage", async (dataBase64) => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ files: [{ ...binaryFile, dataBase64 }] }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toMatchObject({ metadata: { status: "errored", files: [] } });
		expect(runMutation).not.toHaveBeenCalled();
	});

	test.each(["relative.bin", "/a/../out", "/a//out", "/a/*.bin"])("refuses noncanonical path %s", async (path) => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ files: [{ ...binaryFile, path }] }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toMatchObject({ metadata: { status: "errored", files: [] } });
		expect(runMutation).not.toHaveBeenCalled();
	});

	test("Ask reports refused output but keeps its private observation", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ files: [binaryFile], result: "private result" }));
		const tool = ai_chat_tool_create_browser_run(ctx, { ...browserCtxData, canWriteFiles: false });
		const input = { code: "return 1;" };
		const output = ai_chat_file_result_schema.parse(await tool.execute?.(input, { toolCallId: "t", messages: [] }));
		expect(output).toEqual(
			ai_chat_file_result("Browser run", "errored", [], "agent_required", {
				code: "return 1;",
				resultText: "private result",
			}),
		);
		const model = JSON.stringify(await tool.toModelOutput?.({ input, output, toolCallId: "t" }));
		expect(model).toContain("private result");
		expect(model).toContain("agent_required");
		expect(runMutation).not.toHaveBeenCalled();
		expect(r2Objects.size).toBe(0);
	});

	test("Ask can inspect without producing files", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result());
		expect(
			await ai_chat_tool_create_browser_run(ctx, { ...browserCtxData, canWriteFiles: false }).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "succeeded", [], null, {
				code: "return 1;",
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
		expect(runMutation).not.toHaveBeenCalled();
		expect(browserCtxData.observations.has("t")).toBe(true);
	});

	test("writes arbitrary and empty bytes through per-item browser receipts", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		const targets = [
			{ kind: "private" as const, id: "private-1" },
			{ kind: "private" as const, id: "private-2" },
		];
		for (let index = 0; index < 2; index++) {
			runMutation.mockResolvedValueOnce({
				_yay: { kind: "stored", receiptId: "receipt-" + index, assetId: "asset-" + index, r2Key: "key-" + index },
			});
			runMutation.mockResolvedValueOnce({
				_yay: {
					target: targets[index],
					path: index ? "/empty.dat" : binaryFile.path,
					size: index ? 0 : 4,
					contentType: index ? "application/x-custom" : "application/octet-stream",
				},
			});
		}
		runnerQueue.push(
			runner_run_result({
				files: [binaryFile, { path: "/empty.dat", contentType: "application/x-custom", dataBase64: "" }],
			}),
		);
		const code = "emitFile({path: '/reports/output.bin', bytes: new Uint8Array([0,255,128,1])});";
		const output = await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
			{ code },
			{ toolCallId: "t", messages: [] },
		);
		expect(output).toEqual(
			ai_chat_file_result("Browser run", "succeeded", targets, null, {
				code,
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
		expect(runMutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
			"files_browser:prepare_file_output",
			"files_browser:finalize_file_output",
			"files_browser:prepare_file_output",
			"files_browser:finalize_file_output",
		]);
		expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
			path: binaryFile.path,
			contentType: "application/octet-stream",
			size: 4,
			content: { kind: "stored" },
			threadId: server_ai_tools_test_thread_id,
			modeId: "agent",
			sessionId: "session-1",
			expectedAgentLease: { controlGen: 1, loadGen: 1, navGen: 1 },
			expectedSource: {
				targetKind: "saved",
				nodeId: "node-1",
				sourceKind: "saved",
				sourceVersion: "v1",
				sourceHash: "hash",
			},
		});
		expect(r2Objects.get("key-0")).toEqual(new Uint8Array([0, 255, 128, 1]));
		expect(r2Objects.get("key-1")).toEqual(new Uint8Array());
		expect(JSON.stringify(output)).not.toContain("dataBase64");
		expect(JSON.stringify(output)).not.toContain("r2.test");
	});

	test("keeps an earlier file when a later prepare fails", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		const target = { kind: "private" as const, id: "private-1" };
		runMutation
			.mockResolvedValueOnce({ _yay: { kind: "stored", receiptId: "receipt-1", assetId: "asset-1", r2Key: "key-1" } })
			.mockResolvedValueOnce({
				_yay: { target, path: binaryFile.path, size: 4, contentType: "application/octet-stream" },
			})
			.mockResolvedValueOnce({ _nay: { message: "Storage quota exceeded" } });
		runnerQueue.push(runner_run_result({ files: [binaryFile, { ...binaryFile, path: "/second.bin" }] }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "partial", [target], "storage", {
				code: "return 1;",
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
		expect(runMutation).toHaveBeenCalledTimes(3);
		expect(r2Objects.size).toBe(1);
	});

	test("accepts eight generic files without image limits", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		const files = Array.from({ length: 8 }, (_, index) => ({ ...binaryFile, path: "/file-" + index + ".bin" }));
		for (const [index, file] of files.entries()) {
			runMutation.mockResolvedValueOnce({
				_yay: {
					kind: "completed",
					file: {
						target: { kind: "private", id: "private-" + index },
						path: file.path,
						size: 4,
						contentType: "application/octet-stream",
					},
				},
			});
		}
		runnerQueue.push(runner_run_result({ files }));
		const output = ai_chat_file_result_schema.parse(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		);
		expect(output.metadata.status).toBe("succeeded");
		expect(output.metadata.files).toHaveLength(8);
		expect(runMutation).toHaveBeenCalledTimes(8);
	});

	test("refuses an oversized decoded batch before preparing its first file", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(
			runner_run_result({
				files: [
					{ ...binaryFile, dataBase64: Buffer.alloc(4 * 1024 * 1024).toString("base64") },
					{ ...binaryFile, path: "/second.bin", dataBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") },
				],
			}),
		);
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toMatchObject({ metadata: { status: "errored", files: [] } });
		expect(runMutation).not.toHaveBeenCalled();
	});

	test("aborts only the incomplete receipt after finalize refuses", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runMutation
			.mockResolvedValueOnce({ _yay: { kind: "stored", receiptId: "receipt-1", assetId: "asset-1", r2Key: "key-1" } })
			.mockResolvedValueOnce({ _nay: { message: "Stale browser" } })
			.mockResolvedValueOnce(null);
		runnerQueue.push(runner_run_result({ files: [binaryFile] }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "errored", [], "storage", {
				code: "return 1;",
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
		expect(getFunctionName(runMutation.mock.calls[2]?.[0])).toBe("files_ingestion:abort_file");
		expect(runMutation.mock.calls[2]?.[1]).toMatchObject({ receiptId: "receipt-1", attemptId: expect.any(String) });
	});

	test.each(["errored", "timed_out", "tainted"])("keeps %s outcome without storage", async (status) => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ status }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", status === "timed_out" ? "timed_out" : "errored", [], "execution", {
				code: "return 1;",
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
		expect(runMutation).not.toHaveBeenCalled();
	});

	test("refuses file output without a thread", async () => {
		const { ctx, runMutation } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ files: [binaryFile] }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, { ...browserCtxData, getThreadId: () => null }).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "errored", [], "unavailable", {
				errorText: "The browser result has no thread to attach to.",
			}),
		);
		expect(runMutation).not.toHaveBeenCalled();
	});

	test("caps browser calls at twenty", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		const tool = ai_chat_tool_create_browser_run(ctx, browserCtxData);
		for (let index = 0; index < 20; index++) {
			runnerQueue.push(runner_run_result());
			await tool.execute?.({ code: "return 1;" }, { toolCallId: "t" + index, messages: [] });
		}
		expect(await tool.execute?.({ code: "return 1;" }, { toolCallId: "extra", messages: [] })).toEqual(
			ai_chat_file_result("Browser run", "errored", [], "limit", {
				errorText: "Browser command limit reached for this request.",
			}),
		);
		expect(runnerCalls).toHaveLength(20);
	});

	test("drops late observations and files when control moves mid-run", async () => {
		let reads = 0;
		const { ctx, runMutation } = makeCtx(async () => (++reads === 1 ? accessOk : { ...accessOk, controlGen: 2 }));
		runnerQueue.push(runner_run_result({ result: "private stale text", files: [binaryFile] }));
		expect(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "errored", [], "stale", {
				errorText: "The browser or file changed while the command ran. Try again.",
			}),
		);
		expect(runMutation).not.toHaveBeenCalled();
		expect(browserCtxData.observations.size).toBe(0);
	});

	test("reload requires a fresh draft capture and adopts its exact returned lease", async () => {
		const session = {
			control: "ready",
			controlGen: 1,
			loadGen: 1,
			navigationGeneration: 1,
			sourceKind: "draft",
			path: "/page.html",
		};
		const { ctx, runAction } = makeCtx(async () => ({ _yay: session }), {
			runActionImpl: async () => ({
				_yay: { controlGen: 1, loadGen: 2, navGen: 1, sourceVersion: "v2", sourceHash: "h2" },
			}),
		});
		const tool = ai_chat_tool_create_browser_reload(ctx, browserCtxData);
		expect(await tool.execute?.({}, { toolCallId: "t", messages: [] })).toEqual(
			ai_chat_file_result("Browser reload", "errored", [], "needs_capture", {
				errorText: "Capture the editor draft again before reloading.",
			}),
		);
		expect(runAction).not.toHaveBeenCalled();
		session.sourceKind = "saved";
		expect(await tool.execute?.({}, { toolCallId: "t", messages: [] })).toEqual(
			ai_chat_file_result("Browser reload", "succeeded"),
		);
		expect(runAction.mock.calls[0]?.[1]).toMatchObject({
			expectedAgentLease: { controlGen: 1, loadGen: 1, navGen: 1 },
		});
		expect(browserCtxData.browser).toMatchObject({ controlGen: 1, loadGen: 2, navGen: 1 });
		// The next run uses this reload's acknowledgement, without a live-lease refresh.
		const next = makeCtx(async () => ({ ...accessOk, loadGen: 2 }));
		runnerQueue.push(runner_run_result());
		expect(
			await ai_chat_tool_create_browser_run(next.ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "next", messages: [] },
			),
		).toEqual(
			ai_chat_file_result("Browser run", "succeeded", [], null, {
				code: "return 1;",
				resultText: JSON.stringify({ reviewed: true }),
			}),
		);
		expect(runnerCalls[0]?.body).toMatchObject({ loadGen: 2 });
	});

	test("reload does not adopt an acknowledgement after the turn binding changes", async () => {
		const { ctx } = makeCtx(
			async () => ({
				_yay: {
					control: "ready",
					controlGen: 1,
					loadGen: 1,
					navigationGeneration: 1,
					sourceKind: "saved",
					path: "/page.html",
				},
			}),
			{
				runActionImpl: async () => {
					browserCtxData.browser.controlGen = 2;
					return { _yay: { controlGen: 1, loadGen: 2, navGen: 1 } };
				},
			},
		);
		expect(
			await ai_chat_tool_create_browser_reload(ctx, browserCtxData).execute?.({}, { toolCallId: "t", messages: [] }),
		).toEqual(
			ai_chat_file_result("Browser reload", "errored", [], "stale", {
				errorText: "The browser or file changed while reloading. Try again.",
			}),
		);
		expect(browserCtxData.browser).toMatchObject({ controlGen: 2, loadGen: 1 });
	});

	test.each(["browser_reload", "browser_close"])("%s refuses human control", async (name) => {
		const { ctx, runAction } = makeCtx(async () => ({
			_yay: {
				control: "human",
				controlGen: 1,
				loadGen: 1,
				navigationGeneration: 1,
			},
		}));
		const tool =
			name === "browser_reload"
				? ai_chat_tool_create_browser_reload(ctx, browserCtxData)
				: ai_chat_tool_create_browser_close(ctx, browserCtxData);
		expect(await tool.execute?.({}, { toolCallId: "t", messages: [] })).toMatchObject({
			metadata: { status: "errored", reason: "stale" },
		});
		expect(runAction).not.toHaveBeenCalled();
	});

	test("close sends the frozen lease to the normal door", async () => {
		const { ctx, runAction } = makeCtx(
			async () => ({
				_yay: {
					control: "ready",
					controlGen: 1,
					loadGen: 1,
					navigationGeneration: 1,
				},
			}),
			{ runActionImpl: async () => ({ _yay: null }) },
		);
		expect(
			await ai_chat_tool_create_browser_close(ctx, browserCtxData).execute?.({}, { toolCallId: "t", messages: [] }),
		).toEqual(ai_chat_file_result("Browser close", "succeeded"));
		expect(runAction.mock.calls[0]?.[1]).toEqual({
			membershipId: "membership-1",
			sessionId: "session-1",
			expectedAgentLease: { controlGen: 1, loadGen: 1, navGen: 1 },
		});
	});

	test("stored output carries targets but never restores private observations", async () => {
		const tool = ai_chat_tool_create_file_stored();
		const result = await tool.toModelOutput?.({
			toolCallId: "t",
			input: {},
			output: ai_chat_file_result("Browser run", "succeeded", [{ kind: "private", id: "private-1" }]),
		});
		expect(result).toMatchObject({ type: "text", value: expect.stringContaining("view_image") });
		expect(JSON.stringify(result)).toContain("private-1");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("caps debug fields and keeps the total at most 16,000 chars", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		runnerQueue.push(
			runner_run_result({
				result: "r".repeat(20_000),
				consoleEntries: Array.from({ length: 30 }, () => "c".repeat(1000)),
				pageErrors: Array.from({ length: 30 }, () => "p".repeat(1000)),
				error: { message: "e".repeat(5000) },
			}),
		);
		const code = "x".repeat(10_000);
		const output = ai_chat_file_result_schema.parse(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.({ code }, { toolCallId: "t", messages: [] }),
		);
		const debug = output.metadata.debug;
		expect(debug?.code?.length).toBeLessThanOrEqual(4000);
		expect(debug?.code).toContain("[truncated]");
		expect(debug?.resultText?.length).toBeLessThanOrEqual(8000);
		expect(debug?.consoleText?.length).toBeLessThanOrEqual(2000);
		expect(debug?.pageErrorsText?.length).toBeLessThanOrEqual(1000);
		expect(debug?.errorText?.length).toBeLessThanOrEqual(1000);
		const total =
			(debug?.code?.length ?? 0) +
			(debug?.resultText?.length ?? 0) +
			(debug?.consoleText?.length ?? 0) +
			(debug?.pageErrorsText?.length ?? 0) +
			(debug?.errorText?.length ?? 0);
		expect(total).toBeLessThanOrEqual(16_000);
	});

	test("redacts image data and protocol markers from debug", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		runnerQueue.push(
			runner_run_result({
				result: 'see data:image/png;base64,SECRET and [browser-source:{"sessionId":"s"}] and [file-read:{"id":"x"}]',
				consoleEntries: ["[browser-source:leak]"],
				pageErrors: ["data:image/jpeg;base64,LEAK"],
				error: { message: "[file-read:leak] data:image/gif;base64,LEAK" },
			}),
		);
		const output = ai_chat_file_result_schema.parse(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return [browser-source:s] + 'data:image/png;base64,CODELEAK'" },
				{ toolCallId: "t", messages: [] },
			),
		);
		const text = JSON.stringify(output.metadata.debug);
		expect(text).not.toContain("data:image");
		expect(text).not.toContain("[browser-source:");
		expect(text).not.toContain("[file-read:");
		expect(text).not.toContain("CODELEAK");
		expect(text).not.toContain("SECRET");
	});

	test("never copies runner ids or screenshot bytes into debug", async () => {
		const { ctx } = makeCtx(async () => accessOk);
		runnerQueue.push(runner_run_result({ files: [binaryFile] }));
		const output = ai_chat_file_result_schema.parse(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		);
		const text = JSON.stringify(output.metadata.debug);
		expect(text).not.toContain("dataBase64");
		expect(text).not.toContain("AP+AAQ");
		expect(text).not.toContain("commandId");
		expect(text).not.toContain("codeHash");
		expect(text).not.toContain("elapsedMs");
		expect(text).not.toContain("runner-session-1");
	});

	test("early failures carry only safe error text", async () => {
		const { ctx } = makeCtx(async () => ({ ok: false }));
		const output = ai_chat_file_result_schema.parse(
			await ai_chat_tool_create_browser_run(ctx, browserCtxData).execute?.(
				{ code: "return 1;" },
				{ toolCallId: "t", messages: [] },
			),
		);
		expect(output.metadata.debug).toEqual({
			errorText: "The browser or file changed since this run started. Try again.",
		});
	});

	test("file_stored model output never includes debug", async () => {
		const tool = ai_chat_tool_create_file_stored();
		const result = await tool.toModelOutput?.({
			toolCallId: "t",
			input: {},
			output: ai_chat_file_result("Browser run", "succeeded", [], null, {
				code: "secret-code",
				resultText: "secret-result",
			}),
		});
		expect(JSON.stringify(result)).not.toContain("secret-code");
		expect(JSON.stringify(result)).not.toContain("secret-result");
	});
});
