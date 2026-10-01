import { createCommandContext, InMemoryFs, type CommandContext } from "just-bash/browser";
import { getFunctionName } from "convex/server";
import type { Infer } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { ai_chat_browser_resource_validator } from "../convex/schema.ts";
import { ai_chat_files_browser_resource_key } from "../convex/ai_chat_files.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";
import { bash_browser_command_create, type bash_BrowserContext } from "./bash-browser-command.ts";

type BrowserResource = Infer<typeof ai_chat_browser_resource_validator>;

beforeEach(() => {
	vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "true");
	vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "true");
	vi.stubEnv("BROWSER_RUNNER_URL", "https://browser-runner.test");
	vi.stubEnv("BROWSER_RUNNER_SECRET", "test-secret");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

/**
 * A fake chat call: the turn doors keep their state in memory, and every other door answers by name.
 */
function fixture(provider: "playwriter" | "cloud") {
	const source = {
		organizationId: "org" as Id<"organizations">,
		workspaceId: "workspace" as Id<"organizations_workspaces">,
		userId: "owner" as Id<"users">,
		membershipId: "membership" as Id<"organizations_workspaces_users">,
		membershipLifetime: 1,
		threadId: "chat" as Id<"ai_chat_threads">,
		sourceMessageId: "user-message" as Id<"ai_chat_threads_messages_aisdk_5">,
	};
	let commandNumber = 0;
	const browser: bash_BrowserContext = {
		source,
		browserIntent: {
			webChoice:
				provider === "playwriter"
					? { provider: "playwriter", connectionId: "connection", confirmedTargetHandle: "opaque-tab" }
					: { provider: "cloud" },
			selectionRevision: 1,
			policyRevision: 0,
		},
		run: { runId: "run" as Id<"ai_chat_runs">, generation: 1 },
		canWriteFiles: false,
		invocationId: "bash-call" as Id<"ai_chat_bash_invocations">,
		deadlineAt: Date.now() + 240_000,
		signal: new AbortController().signal,
		nextCommandNumber: () => commandNumber++,
	};
	const turn = { bindings: [] as BrowserResource[], revoked: false, operations: 0 };

	const runtime = {
		generation: 1,
		state: "connected" as const,
		targets: [],
		confirmedTargetId: "native-private",
		targetRevision: 1,
		navRevision: 0,
		controlRevision: 0,
		policyRevision: 0,
		selectionRevision: 1,
		agentAccess: true,
		operations: 1,
		idleExpiresAt: Date.now() + 600_000,
		totalExpiresAt: Date.now() + 3_600_000,
		sessionId: "remote-session",
		inventoryRevision: 1,
	};
	const remote = {
		provider: "playwriter" as const,
		connectionId: "connection" as Id<"playwriter_connections">,
		connectionGeneration: 1,
		targetRevision: 1,
		controlRevision: 0,
		navRevision: 0,
		confirmedTargetHandle: "opaque-tab",
	};
	const connection = {
		_id: remote.connectionId,
		ownerId: source.userId,
		organizationId: source.organizationId,
		workspaceId: source.workspaceId,
		connectAttemptId: "dial",
		controlRevision: 0,
		confirmedTargetId: "native-private",
		pendingAcknowledgement: null,
	} as Partial<Doc<"playwriter_connections">> as Doc<"playwriter_connections">;
	const cloudTab = {
		provider: "cloud" as const,
		mode: "web" as const,
		sessionId: "cloud" as Id<"files_browser_sessions">,
		controlGen: 1,
		loadGen: 1,
		navGen: 2,
		tabId: "tab-1234567890",
		tabGen: 2,
	};
	// The access read of the cloud tab. A test moves it to act like a person or the runner.
	const cloudAccess = { ok: true, mode: "web", control: "ready", controlGen: 1, loadGen: 1, navGen: 2, tabGen: 2 };

	const runQuery = vi.fn(async (ref, _args): Promise<unknown> => {
		const name = getFunctionName(ref);
		if (name === "ai_chat_files:get_browser_turn") return { _yay: structuredClone(turn) };
		if (name === "files_browser:check_browser_source") return { _yay: null };
		// The lease follows the runtime, as the doors write it after each command.
		if (name === "playwriter_browser:get_remote_lease")
			return {
				_yay: {
					...remote,
					navRevision: runtime.navRevision,
					targetRevision: runtime.targetRevision,
					controlRevision: runtime.controlRevision,
				},
			};
		if (name === "playwriter_browser:load_connection") return { _yay: connection };
		if (name === "files_browser:get_agent_browser_catalog")
			return { _yay: { browsers: provider === "cloud" ? [{ resource: cloudTab }] : [] } };
		if (name === "files_browser:check_browser_session_access")
			return { ...cloudAccess, runnerSessionId: "private-runner" };
		// No runner session id, so the check skips the runner status call.
		if (name === "files_browser:load_browser_session") return { _yay: { mode: "web", runnerSessionId: null } };
		if (name === "ai_chat_workspaces:resolve")
			return {
				_yay: {
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			};
		throw new Error(`Unexpected query ${name}`);
	});
	const runMutation = vi.fn(async (ref, args): Promise<unknown> => {
		const name = getFunctionName(ref);
		if (name === "ai_chat_files:update_browser_turn") {
			const change = args.change;
			if (change.kind === "revoke") turn.revoked = true;
			else if (turn.revoked) return { _nay: { name: "stale", message: "Browser access ended for this turn" } };
			else if (change.kind === "claim") {
				if (turn.operations >= 20) return { _nay: { name: "limit", message: "Browser operation limit reached" } };
				turn.operations++;
			} else if (change.kind === "bind")
				for (const binding of change.bindings as BrowserResource[]) {
					const key = ai_chat_files_browser_resource_key(binding);
					const index = turn.bindings.findIndex((item) => ai_chat_files_browser_resource_key(item) === key);
					if (index === -1) turn.bindings.push(binding);
					else if (!change.ifAbsent) turn.bindings[index] = binding;
				}
			else
				turn.bindings = turn.bindings.filter(
					(item) => !(change.keys as string[]).includes(ai_chat_files_browser_resource_key(item)),
				);
			return { _yay: structuredClone(turn) };
		}
		const invocation = {
			isNew: true,
			invocationId: `claim-${args.toolCallId}`,
			commandId: `command-${args.toolCallId}`,
			deadlineAt: Date.now() + 30_000,
			receiptResolutionDeadline: Date.now() + 35_000,
		};
		if (name === "playwriter_browser:reserve_command")
			return { _yay: { connection, invocation, allowedVersions: ["0.5.0"] } };
		if (name === "ai_chat_files:begin_browser_invocation") return { _yay: invocation };
		if (name === "playwriter_browser:commit_runtime" || name === "playwriter_browser:finish_command") return true;
		// A completed receipt skips the upload, so the test needs no R2.
		if (name === "playwriter_browser:prepare_file_output")
			return { _yay: { kind: "completed", file: { path: args.path } } };
		if (name === "files_browser:sync_browser_session") {
			Object.assign(cloudAccess, { navGen: args.runner.navGen });
			return { _yay: true };
		}
		return { _yay: null };
	});
	const runAction = vi.fn();
	const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;

	/**
	 * A completed shared-tab reply. The completed lease is read from the runtime before `change`
	 * runs, so `change` can act like a navigation or a pause that came after the script.
	 */
	const script_reply = (script: Record<string, unknown>, change = () => {}) => {
		const completedLease = {
			generation: runtime.generation,
			controlRevision: runtime.controlRevision,
			policyRevision: runtime.policyRevision,
			selectionRevision: runtime.selectionRevision,
			confirmedTargetId: runtime.confirmedTargetId,
			navRevision: runtime.navRevision,
			targetRevision: runtime.targetRevision,
		};
		change();
		return {
			ok: true,
			status: "completed",
			runtime,
			completedLease,
			result: { ok: true, reason: null, inputSent: true, cleanup: "complete" },
			script: {
				status: "succeeded",
				resultJson: null,
				resultTruncated: false,
				error: null,
				logs: [],
				logsTruncated: false,
				consoleEntries: [],
				pageErrors: [],
				stateWarnings: [],
				files: [],
				...script,
			},
		};
	};

	const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
	// What the runner answers to `run`. A test replaces it.
	let reply: (body: Record<string, unknown>) => Promise<unknown> = async () =>
		script_reply({ resultJson: '"Example Domain"', logs: ["first log"], consoleEntries: ["page console"] });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const route = String(input).split("/").at(-1)!;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ route, body });
			if (route === "status") return Response.json({ ok: true, runtime });
			if (route === "command-ack")
				return Response.json({ ok: true, status: "acknowledged", runtime, completedLease: null, result: null });
			return Response.json(await reply(body));
		}),
	);

	const command = bash_browser_command_create(ctx, browser);
	// The test code is ASCII, so each character is already one byte of the ByteString stdin.
	const exec = (args: string[], stdin = "") =>
		command.execute(
			args,
			createCommandContext({ fs: new InMemoryFs(), cwd: "/", stdin: stdin as unknown as CommandContext["stdin"] }),
		);
	return {
		browser,
		turn,
		runtime,
		cloudAccess,
		requests,
		runMutation,
		exec,
		script_reply,
		setReply: (next: typeof reply) => {
			reply = next;
		},
	};
}

function mutation_names(f: ReturnType<typeof fixture>) {
	return f.runMutation.mock.calls.map(([ref]) => getFunctionName(ref));
}

describe("bash_browser_command_create", () => {
	test("My browser runs a script and prints its own output, like the Playwriter CLI", async () => {
		const f = fixture("playwriter");
		const result = await f.exec(["run", "-e", "console.log('first log'); return await page.title();"]);
		expect(result).toEqual({
			stdout: "first log\nExample Domain\n",
			stderr: "[console] page console\n",
			exitCode: 0,
		});
		expect(f.requests.find((request) => request.route === "run")?.body.operation).toEqual({
			kind: "script",
			code: "console.log('first log'); return await page.title();",
		});
		// The tool call id is unique per browser operation inside this Bash call.
		expect(
			f.runMutation.mock.calls.find(([ref]) => getFunctionName(ref) === "playwriter_browser:reserve_command")?.[1],
		).toMatchObject({ toolCallId: "bash-call:browser:0", run: f.browser.run });
		expect(f.turn).toMatchObject({ operations: 1, revoked: false, bindings: [{ provider: "playwriter" }] });
	});

	test("reads the code from stdin when -e is left out", async () => {
		const f = fixture("playwriter");
		expect((await f.exec(["run"], "return 1;\n")).exitCode).toBe(0);
		expect(f.requests.find((request) => request.route === "run")?.body.operation).toEqual({
			kind: "script",
			code: "return 1;\n",
		});
	});

	test.each([
		{ status: "errored", exitCode: 1 },
		{ status: "timed_out", exitCode: 124 },
	] as const)("a script that ends $status exits $exitCode with its error on stderr", async ({ status, exitCode }) => {
		const f = fixture("playwriter");
		f.setReply(async () =>
			f.script_reply({ status, error: { name: "TimeoutError", message: "locator.click: Timeout 5000ms exceeded" } }),
		);
		expect(await f.exec(["run", "-e", "await page.click('#missing');"])).toEqual({
			stdout: "",
			stderr: "Error: TimeoutError: locator.click: Timeout 5000ms exceeded\n",
			exitCode,
		});
		// The receipt finished, so the turn keeps its access.
		expect(f.turn.revoked).toBe(false);
	});

	test("My browser saves emitted files only in Agent mode, checked against the lease the run used", async () => {
		const f = fixture("playwriter");
		const shot = { workspace: "current", path: "/shot.png", dataBase64: "AQID" };
		f.setReply(async () => f.script_reply({ files: [shot] }));
		expect(await f.exec(["run", "-e", "await emitFile('/shot.png', await page.screenshot());"])).toEqual({
			stdout: "",
			stderr: "browser: saving files needs Agent mode. Nothing was saved.\n",
			exitCode: 1,
		});
		expect(mutation_names(f)).not.toContain("playwriter_browser:prepare_file_output");

		f.browser.canWriteFiles = true;
		expect(await f.exec(["run", "-e", "await emitFile('/shot.png', await page.screenshot());"])).toEqual({
			stdout: "",
			stderr: "browser: pending file /shot.png. The user reviews it in Files.\n",
			exitCode: 0,
		});
		const prepare = f.runMutation.mock.calls.find(
			([ref]) => getFunctionName(ref) === "playwriter_browser:prepare_file_output",
		)?.[1];
		expect(prepare).toMatchObject({
			path: "/shot.png",
			modeId: "agent",
			expectedLease: expect.objectContaining({ provider: "playwriter", connectionId: "connection" }),
		});
	});

	test("adopts a navigation the script's click caused after it returned", async () => {
		const f = fixture("playwriter");
		await f.exec(["status"]);
		f.setReply(async () =>
			f.script_reply({}, () => {
				f.runtime.navRevision = 1;
				f.runtime.targetRevision = 2;
			}),
		);
		expect((await f.exec(["run", "-e", "await page.click('a');"])).exitCode).toBe(0);
		expect(f.turn.revoked).toBe(false);
		expect(f.turn.bindings).toEqual([expect.objectContaining({ navRevision: 1, targetRevision: 2 })]);
	});

	test("a person's pause during the run ends browser access for the turn", async () => {
		const f = fixture("playwriter");
		await f.exec(["status"]);
		f.setReply(async () =>
			f.script_reply({ resultJson: '"private page text"' }, () => {
				f.runtime.controlRevision = 1;
			}),
		);
		const result = await f.exec(["run", "-e", "return document.body.innerText;"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Browser access ended for this turn. Do not retry.");
		expect(f.turn.revoked).toBe(true);

		// The next command refuses before it reaches the runner.
		const runs = f.requests.filter((request) => request.route === "run").length;
		expect((await f.exec(["run", "-e", "return 1;"])).stderr).toContain("Do not retry.");
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(runs);
	});

	test("a lost reply is unknown and is never run again", async () => {
		const f = fixture("playwriter");
		f.setReply(async () => {
			throw new Error("Lost network reply");
		});
		const result = await f.exec(["run", "-e", "await page.click('#buy');"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("the action may have run. Do not repeat it.");
		expect(mutation_names(f)).not.toContain("playwriter_browser:finish_command");
	});

	test("refuses the 21st browser operation of a turn before reserving it", async () => {
		const f = fixture("playwriter");
		f.turn.operations = 20;
		expect((await f.exec(["run", "-e", "return 1;"])).stderr).toBe(
			"browser: this turn used all 20 browser operations.\n",
		);
		expect(mutation_names(f)).not.toContain("playwriter_browser:reserve_command");
		expect(f.requests.filter((request) => request.route === "run")).toEqual([]);
	});

	test("the cloud browser prints the run, redacts image data, and refuses files in Ask mode", async () => {
		const f = fixture("cloud");
		const code = "return 'data:image/png;base64,AAAA';";
		const codeHash = await crypto_sha256_hex(`browser-v3\n${code}`);
		f.setReply(async (body) => ({
			ok: true,
			status: "succeeded",
			commandId: body.commandId,
			codeHash,
			elapsedMs: 1,
			result: "data:image/png;base64,AAAA",
			resultTruncated: false,
			files: [{ workspace: "current", path: "/shot.png", dataBase64: "AAAA" }],
			consoleEntries: [],
			pageErrors: [],
			logs: [],
			logsTruncated: false,
			error: null,
			session: {
				mode: "web",
				sessionId: "private-runner",
				control: "ready",
				controlGen: 1,
				loadGen: 1,
				navGen: 3,
				tabId: "tab-1234567890",
				tabGen: 2,
				viewedTabId: null,
				viewGen: 1,
				tabCount: 1,
				agentAccess: true,
				selectionRevision: 1,
				policyRevision: 0,
				idleUntil: Date.now() + 60_000,
				totalUntil: Date.now() + 600_000,
			},
		}));
		expect(await f.exec(["run", "-e", code])).toEqual({
			stdout: "[redacted image]\n",
			stderr: "browser: saving files needs Agent mode. Nothing was saved.\n",
			exitCode: 1,
		});
		expect(f.requests.find((request) => request.route === "run")?.body).toMatchObject({
			tabId: "tab-1234567890",
			navGen: 2,
			source: { chatId: "chat", sourceMessageId: "user-message", toolCallId: "bash-call:browser:0" },
		});
		expect(mutation_names(f)).not.toContain("files_browser:prepare_file_output");
		// The run's own navigation is adopted.
		expect(f.turn.bindings).toEqual([expect.objectContaining({ navGen: 3 })]);
	});

	test("the cloud browser refuses a run after a person took control", async () => {
		const f = fixture("cloud");
		await f.exec(["status"]);
		f.cloudAccess.controlGen = 2;
		const result = await f.exec(["run", "-e", "return 1;"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Browser access ended for this turn.");
		expect(f.turn.revoked).toBe(true);
		expect(f.requests.filter((request) => request.route === "run")).toEqual([]);
	});

	test.each([
		{ args: ["status", "-e", "return 1;"], text: "-e works only with run" },
		{ args: ["run", "--tab", "ab"], text: "--tab needs a tab id of at least 4 characters" },
		{ args: ["run", "--file", "--tab", "tab-1"], text: "use --tab or --file, not both" },
		{ args: ["scroll"], text: "unknown subcommand scroll" },
	])("$args is a usage error that reaches no door", async ({ args, text }) => {
		const f = fixture("cloud");
		const result = await f.exec(args);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(text);
		expect(f.runMutation).not.toHaveBeenCalled();
	});

	test("does not start a run that could outlast the Bash call", async () => {
		const f = fixture("playwriter");
		f.browser.deadlineAt = Date.now() + 10_000;
		const result = await f.exec(["run", "-e", "return 1;"]);
		expect(result.exitCode).toBe(124);
		expect(mutation_names(f)).not.toContain("playwriter_browser:reserve_command");
	});
});
